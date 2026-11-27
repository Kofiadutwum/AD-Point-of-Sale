import 'server-only';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import {
  branches, type OnlineOrderStatus, onlineOrders, type OrderLine, type OrderSource, phoneVerifications, products, shopCharges, stockBalances, tenants, variants, variantUnits,
} from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { normaliseGhanaPhone } from '@/lib/contact';
import { formatCedis } from '@/lib/money';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { newToken, tokenHash } from './crypto';
import { reserveStock } from './customer-orders';
import type { ImageStore } from './image-store';
import { processUpload } from './images';
import { queue } from './notifications';
import { type Fail, fail, isUuid } from './products';
import { priceCart, tillSale } from './quotes';
import { completeSaleTx, throwSaleFailure } from './sales';
import { liveShop } from './storefront';
import { type SendSms, sendSms } from './sms';
import { emitEvent } from './webhooks';

// Spec 6.49: storefront online orders. Prices come from the public catalogue, the phone is verified by SMS first,
// stock is reserved until the order is paid and collected (or it expires), and the customer gets an SMS at each step.

const CODE_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;
const CODES_PER_HOUR = 3;
const ORDERS_PER_HOUR_PHONE = 5;
const ORDERS_PER_HOUR_IP = 10;
const SOURCES: readonly OrderSource[] = ['storefront', 'whatsapp', 'instagram', 'facebook'];
const codeHash = (id: string, code: string) => createHash('sha256').update(`${id}:${code}`).digest('hex');
const OPEN: readonly OnlineOrderStatus[] = ['awaiting_payment', 'proof_uploaded', 'confirmed', 'ready', 'out_for_delivery'];

export type OnlineOrderSettings = { enabled: boolean; expiryMinutes: number; deliveryFeePesewas: number; transferInstructions: string | null };

export async function getOnlineOrderSettings(db: Db, ctx: Ctx): Promise<OnlineOrderSettings> {
  assertPermission(ctx, 'manage_storefront');
  const [t] = await withTenant(db, ctx.tenantId, (tx) => tx.select({ enabled: tenants.onlineOrdersEnabled, expiryMinutes: tenants.onlineOrderExpiryMinutes, deliveryFeePesewas: tenants.deliveryFeePesewas, transferInstructions: tenants.transferInstructions })
    .from(tenants).where(eq(tenants.id, ctx.tenantId)));
  return t;
}

export async function saveOnlineOrderSettings(db: Db, ctx: Ctx, input: OnlineOrderSettings): Promise<{ ok: true } | Fail<'invalid_input'>> {
  assertPermission(ctx, 'manage_storefront');
  const instructions = input.transferInstructions?.trim().slice(0, 500) || null;
  if (!Number.isInteger(input.expiryMinutes) || input.expiryMinutes < 10 || input.expiryMinutes > 10080 || !Number.isInteger(input.deliveryFeePesewas) || input.deliveryFeePesewas < 0 || input.deliveryFeePesewas > 100_000_00) return fail('invalid_input');
  await withTenant(db, ctx.tenantId, async (tx) => {
    await tx.update(tenants).set({ onlineOrdersEnabled: input.enabled, onlineOrderExpiryMinutes: input.expiryMinutes, deliveryFeePesewas: input.deliveryFeePesewas, transferInstructions: instructions }).where(eq(tenants.id, ctx.tenantId));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'online_order_settings_saved', changes: { enabled: input.enabled, expiryMinutes: input.expiryMinutes } });
  });
  return { ok: true };
}

type OrderShop = { id: string; slug: string; name: string; phone: string | null; managerPhone: string | null; expiryMinutes: number; deliveryFeePesewas: number; transferInstructions: string | null; paystack: boolean };

/** A live storefront that takes online orders, or null. */
async function orderShop(db: Db, slug: string, now: Date): Promise<OrderShop | null> {
  return asPlatform(db, async (tx) => {
    const live = await liveShop(tx, slug, now);
    if (!live) return null;
    const [t] = await tx.select({ enabled: tenants.onlineOrdersEnabled, managerPhone: tenants.managerPhone, expiryMinutes: tenants.onlineOrderExpiryMinutes, deliveryFeePesewas: tenants.deliveryFeePesewas, transferInstructions: tenants.transferInstructions, sealed: tenants.paystackSecretSealed })
      .from(tenants).where(eq(tenants.id, live.id));
    if (!t.enabled) return null;
    return { id: live.id, slug: live.slug, name: live.name, phone: live.phone, managerPhone: t.managerPhone, expiryMinutes: t.expiryMinutes, deliveryFeePesewas: t.deliveryFeePesewas, transferInstructions: t.transferInstructions, paystack: !!t.sealed };
  });
}

/** Spec 6.49 (Phase 7): what can be ordered online, one row per sellable variant, at its base-unit price; never cost or exact stock. */
export async function orderableItems(db: Db, slug: string, now: Date): Promise<Array<{ productId: string; variantId: string; name: string; pricePesewas: number; inStock: boolean }>> {
  const shop = await orderShop(db, slug, now);
  if (!shop) return [];
  return withTenant(db, shop.id, async (tx) => {
    const [branch] = await tx.select({ id: branches.id }).from(branches).orderBy(asc(branches.createdAt)).limit(1);
    const rows = await tx.select({ productId: products.id, variantId: variants.id, product: products.name, variant: variants.name, price: variants.basePricePesewas,
      onHand: stockBalances.onHand, reserved: stockBalances.reserved })
      .from(variants).innerJoin(products, eq(products.id, variants.productId))
      .leftJoin(stockBalances, and(eq(stockBalances.variantId, variants.id), eq(stockBalances.branchId, branch.id)))
      .where(and(eq(products.showOnStorefront, true), eq(products.status, 'active'), eq(products.prescriptionOnly, false), eq(variants.status, 'active'), eq(variants.sellable, true), eq(variants.isGiftCard, false)))
      .orderBy(asc(products.name), asc(variants.basePricePesewas)).limit(300);
    return rows.map((r) => ({ productId: r.productId, variantId: r.variantId, name: r.variant ? `${r.product} – ${r.variant}` : r.product, pricePesewas: r.price, inStock: r.onHand === null || Number(r.onHand) - Number(r.reserved) > 0 })); // no balance row = not stock-tracked
  });
}

export async function publicOrderOptions(db: Db, slug: string, now: Date) {
  const shop = await orderShop(db, slug, now);
  return shop ? { name: shop.name, paystack: shop.paystack, transfer: !!shop.transferInstructions, transferInstructions: shop.transferInstructions, deliveryFeePesewas: shop.deliveryFeePesewas } : null;
}

/** Sends a 6-digit code to the visitor's phone (at most 3 an hour per phone). */
export async function requestPhoneCode(db: Db, slug: string, rawPhone: string, now: Date, send: SendSms = sendSms): Promise<{ ok: true; verificationId: string } | Fail<'closed' | 'invalid_phone' | 'too_many'>> {
  const shop = await orderShop(db, slug, now);
  if (!shop) return fail('closed');
  const phone = normaliseGhanaPhone(rawPhone ?? '');
  if (!phone) return fail('invalid_phone');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const id = randomUUID();
  const ok = await withTenant(db, shop.id, async (tx) => {
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(phoneVerifications)
      .where(and(eq(phoneVerifications.phone, phone), gte(phoneVerifications.createdAt, new Date(now.getTime() - 3_600_000))));
    if (n >= CODES_PER_HOUR) return false;
    await tx.insert(phoneVerifications).values({ id, tenantId: shop.id, phone, codeHash: codeHash(id, code), expiresAt: new Date(now.getTime() + CODE_MINUTES * 60_000), createdAt: now });
    return true;
  });
  if (!ok) return fail('too_many');
  await send(phone, `${shop.name}: your order code is ${code}. It expires in ${CODE_MINUTES} minutes.`);
  return { ok: true, verificationId: id };
}

/** The right code returns a token the browser keeps, so later orders from it skip the SMS step. */
export async function verifyPhoneCode(db: Db, slug: string, verificationId: string, code: string, now: Date): Promise<{ ok: true; token: string; phone: string } | Fail<'closed' | 'wrong_code' | 'expired'>> {
  const shop = await orderShop(db, slug, now);
  if (!shop) return fail('closed');
  if (!isUuid(verificationId) || !/^\d{6}$/.test(code?.trim() ?? '')) return fail('wrong_code');
  const token = newToken();
  return withTenant(db, shop.id, async (tx) => {
    const [v] = await tx.select().from(phoneVerifications).where(eq(phoneVerifications.id, verificationId)).for('update');
    if (!v || v.verifiedAt || v.expiresAt <= now || v.attempts >= MAX_CODE_ATTEMPTS) return fail('expired');
    if (v.codeHash !== codeHash(v.id, code.trim())) {
      await tx.update(phoneVerifications).set({ attempts: v.attempts + 1 }).where(eq(phoneVerifications.id, v.id));
      return fail('wrong_code');
    }
    await tx.update(phoneVerifications).set({ verifiedAt: now, tokenHash: tokenHash(token) }).where(eq(phoneVerifications.id, v.id));
    return { ok: true as const, token, phone: v.phone };
  });
}

async function phoneOfToken(tx: Tx, token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const [v] = await tx.select({ phone: phoneVerifications.phone }).from(phoneVerifications).where(eq(phoneVerifications.tokenHash, tokenHash(token)));
  return v?.phone ?? null;
}

export async function verifiedPhone(db: Db, slug: string, token: string | undefined, now: Date): Promise<string | null> {
  const shop = await orderShop(db, slug, now);
  return shop && token ? withTenant(db, shop.id, (tx) => phoneOfToken(tx, token)) : null;
}

export type PlaceInput = {
  token: string | undefined; items: Array<{ productId: string; variantId?: string; quantity: number }>; fulfilment: 'pickup' | 'delivery';
  name: string; address?: string; note?: string; payMethod: 'paystack' | 'transfer'; source?: string;
};
export type PlaceError = 'closed' | 'phone_not_verified' | 'invalid_input' | 'too_many' | 'unavailable' | 'payment_unavailable';

/** Spec 6.49: creates the order, reserves the stock and tells the shop; the caller then opens Paystack checkout or shows transfer details. */
export async function placeOnlineOrder(db: Db, slug: string, input: PlaceInput, ip: string, now: Date): Promise<
  { ok: true; orderId: string; number: string; totalPesewas: number; tenantId: string } | Fail<PlaceError>
> {
  const shop = await orderShop(db, slug, now);
  if (!shop) return fail('closed');
  const name = input.name?.trim().slice(0, 80) ?? '';
  const address = input.address?.trim().slice(0, 300) || null;
  const items = Array.isArray(input.items) ? input.items : [];
  if (!name || !['pickup', 'delivery'].includes(input.fulfilment) || (input.fulfilment === 'delivery' && !address) || !items.length || items.length > 30
    || items.some((i) => !isUuid(i.productId) || (i.variantId !== undefined && !isUuid(i.variantId)) || !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 99)
    || new Set(items.map((i) => i.variantId ?? i.productId)).size !== items.length) return fail('invalid_input');
  if (input.payMethod === 'paystack' ? !shop.paystack : input.payMethod !== 'transfer' || !shop.transferInstructions) return fail('payment_unavailable');
  const source: OrderSource = SOURCES.includes(input.source as OrderSource) ? input.source as OrderSource : 'storefront';

  return withTenant(db, shop.id, async (tx) => {
    const phone = await phoneOfToken(tx, input.token);
    if (!phone) return fail('phone_not_verified');
    await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, shop.id)).for('update'); // numbers and rate limits, one order at a time
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const [{ byPhone }] = await tx.select({ byPhone: sql<number>`count(*)::int` }).from(onlineOrders).where(and(eq(onlineOrders.contactPhone, phone), gte(onlineOrders.createdAt, hourAgo)));
    const [{ byIp }] = await tx.select({ byIp: sql<number>`count(*)::int` }).from(onlineOrders).where(and(eq(onlineOrders.ip, ip), gte(onlineOrders.createdAt, hourAgo)));
    if (byPhone >= ORDERS_PER_HOUR_PHONE || byIp >= ORDERS_PER_HOUR_IP) return fail('too_many');

    // shortcut: online orders are filled from the shop's first branch; choose a branch per order when shops ask for it
    const [branch] = await tx.select({ id: branches.id }).from(branches).orderBy(asc(branches.createdAt)).limit(1);
    // the chosen variant (or the product's cheapest active one), in its base unit
    const picked = [];
    for (const i of items) {
      const [v] = await tx.select({ variantId: variants.id, unitId: variantUnits.id }).from(variants)
        .innerJoin(products, eq(products.id, variants.productId)).innerJoin(variantUnits, and(eq(variantUnits.variantId, variants.id), eq(variantUnits.isBase, true)))
        .where(and(eq(products.id, i.productId), i.variantId ? eq(variants.id, i.variantId) : undefined, eq(products.showOnStorefront, true), eq(products.status, 'active'), eq(products.prescriptionOnly, false),
          eq(variants.status, 'active'), eq(variants.sellable, true), eq(variants.isGiftCard, false)))
        .orderBy(asc(variants.basePricePesewas)).limit(1);
      if (!v) return fail('unavailable');
      const [bal] = await tx.select({ free: sql<string>`${stockBalances.onHand} - ${stockBalances.reserved}` }).from(stockBalances)
        .where(and(eq(stockBalances.branchId, branch.id), eq(stockBalances.variantId, v.variantId)));
      if (bal && Number(bal.free) < i.quantity) return fail('unavailable'); // no balance row = not stock-tracked
      picked.push({ variantId: v.variantId, unitId: v.unitId, quantity: String(i.quantity), discountPesewas: 0 });
    }
    let priced;
    try { priced = await priceCart(tx, { tenantId: shop.id } as Ctx, branch.id, null, picked, now); } catch { priced = null; }
    if (!priced || priced.totalPesewas <= 0) return fail('unavailable');
    const lines: OrderLine[] = priced.lines.map((l) => ({
      variantId: l.variantId, unitId: l.unitId, name: l.name, unitName: l.unitName, quantity: l.quantity, baseQuantity: l.quantity, unitPricePesewas: l.unitPricePesewas, totalPesewas: l.totalPesewas,
    }));
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(onlineOrders);
    const number = `WEB-${String(n + 1).padStart(4, '0')}`;
    const [o] = await tx.insert(onlineOrders).values({
      tenantId: shop.id, branchId: branch.id, number, source, fulfilment: input.fulfilment, contactName: name, contactPhone: phone, deliveryAddress: input.fulfilment === 'delivery' ? address : null,
      note: input.note?.trim().slice(0, 300) || null, lines, deliveryFeePesewas: input.fulfilment === 'delivery' ? shop.deliveryFeePesewas : 0, totalPesewas: priced.totalPesewas,
      payMethod: input.payMethod, expiresAt: new Date(now.getTime() + shop.expiryMinutes * 60_000), ip, createdAt: now,
    }).returning({ id: onlineOrders.id });
    await reserveStock(tx, shop.id, branch.id, lines, 1);
    await writeAudit(tx, { tenantId: shop.id, actorType: 'system', actorId: null, action: 'online_order_placed', recordType: 'online_order', recordId: o.id, changes: { number, totalPesewas: priced.totalPesewas, source, payMethod: input.payMethod } });
    const shopPhone = shop.managerPhone ?? shop.phone;
    if (shopPhone) await queue(tx, shop.id, { key: `online-new:${o.id}`, kind: 'order', toPhone: shopPhone, body: `New online order ${number} from ${name}: ${formatCedis(priced.totalPesewas)}, ${input.fulfilment}, paying by ${input.payMethod === 'paystack' ? 'Paystack' : 'transfer'}.`, sendAfter: now });
    await queue(tx, shop.id, { key: `online-received:${o.id}`, kind: 'order', toPhone: phone, body: `${shop.name}: we received order ${number} (${formatCedis(priced.totalPesewas)}). Please pay within ${shop.expiryMinutes} minutes or it lapses.`, sendAfter: now });
    await emitEvent(tx, shop.id, 'order.created', { orderId: o.id, number, totalPesewas: priced.totalPesewas, source, fulfilment: input.fulfilment, lines: lines.map((l) => ({ variantId: l.variantId, name: l.name, quantity: l.quantity, totalPesewas: l.totalPesewas })) }, now);
    return { ok: true as const, orderId: o.id, number, totalPesewas: priced.totalPesewas, tenantId: shop.id };
  });
}

const tell = (tx: Tx, tenantId: string, o: { id: string; contactPhone: string }, step: string, body: string, now: Date) =>
  queue(tx, tenantId, { key: `online-${step}:${o.id}`, kind: 'order', toPhone: o.contactPhone, body, sendAfter: now });

async function shopName(tx: Tx, tenantId: string) {
  return (await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)))[0].name;
}

/** Money arrived (Paystack verified, or staff confirmed a transfer): the order is confirmed; a lapsed order takes its stock back. */
export async function markOrderPaid(tx: Tx, tenantId: string, o: typeof onlineOrders.$inferSelect, pay: { amountPesewas: number; reference: string }, now: Date): Promise<boolean> {
  if (!['awaiting_payment', 'proof_uploaded', 'expired'].includes(o.status)) return false;
  if (o.status === 'expired') await reserveStock(tx, tenantId, o.branchId, o.lines, 1);
  await tx.update(onlineOrders).set({ status: 'confirmed', paidPesewas: pay.amountPesewas, paymentReference: pay.reference }).where(eq(onlineOrders.id, o.id));
  await writeAudit(tx, { tenantId, actorType: 'system', actorId: null, action: 'online_order_paid', recordType: 'online_order', recordId: o.id, changes: { amountPesewas: pay.amountPesewas, reference: pay.reference } });
  await tell(tx, tenantId, o, 'confirmed', `${await shopName(tx, tenantId)}: payment received, order ${o.number} is confirmed. We will text you when it is ready.`, now);
  return true;
}

/** The visitor's order page: their own order only (the token's phone must match). */
export async function publicOrder(db: Db, slug: string, orderId: string, token: string | undefined, now: Date) {
  if (!isUuid(orderId)) return null;
  const shop = await asPlatform(db, (tx) => liveShop(tx, slug, now));
  if (!shop) return null;
  return withTenant(db, shop.id, async (tx) => {
    const phone = await phoneOfToken(tx, token);
    const [o] = await tx.select().from(onlineOrders).where(eq(onlineOrders.id, orderId));
    if (!o || !phone || o.contactPhone !== phone) return null;
    const [t] = await tx.select({ transferInstructions: tenants.transferInstructions }).from(tenants).where(eq(tenants.id, shop.id));
    // a visitor who closed the Paystack tab can go back to the same checkout
    const [charge] = o.payMethod === 'paystack' && o.status === 'awaiting_payment'
      ? await tx.select({ url: shopCharges.authorizationUrl }).from(shopCharges).where(and(eq(shopCharges.orderId, o.id), eq(shopCharges.status, 'pending'))).orderBy(desc(shopCharges.createdAt)).limit(1)
      : [];
    return {
      payUrl: charge?.url ?? null,
      shopName: shop.name, number: o.number, status: o.status, fulfilment: o.fulfilment, payMethod: o.payMethod, lines: o.lines, totalPesewas: o.totalPesewas,
      deliveryFeePesewas: o.deliveryFeePesewas, expiresAt: o.expiresAt, hasProof: !!o.proofKey, transferInstructions: o.payMethod === 'transfer' ? t.transferInstructions : null,
    };
  });
}

/** The visitor's own unpaid Paystack order, so a new checkout can be opened when the first one could not be. */
export async function orderAwaitingPaystack(db: Db, slug: string, orderId: string, token: string | undefined, now: Date) {
  if (!isUuid(orderId)) return null;
  const shop = await asPlatform(db, (tx) => liveShop(tx, slug, now));
  if (!shop) return null;
  return withTenant(db, shop.id, async (tx) => {
    const phone = await phoneOfToken(tx, token);
    const [o] = await tx.select().from(onlineOrders).where(eq(onlineOrders.id, orderId));
    if (!o || !phone || o.contactPhone !== phone || o.payMethod !== 'paystack' || o.status !== 'awaiting_payment' || o.expiresAt <= now) return null;
    return { tenantId: shop.id, id: o.id, number: o.number, totalPesewas: o.totalPesewas };
  });
}

/** Spec 6.49: the visitor uploads a screenshot of their transfer; it is compressed and kept privately for staff. */
export async function uploadProof(db: Db, store: ImageStore, slug: string, orderId: string, token: string | undefined, file: Uint8Array, now: Date): Promise<{ ok: true } | Fail<'not_found' | 'not_awaiting' | 'bad_image'>> {
  if (!isUuid(orderId)) return fail('not_found');
  const shop = await asPlatform(db, (tx) => liveShop(tx, slug, now));
  if (!shop) return fail('not_found');
  const img = await processUpload(file);
  if (!img.ok) return fail('bad_image');
  const key = `${shop.id}/${orderId}/${randomUUID()}.webp`;
  return withTenant(db, shop.id, async (tx) => {
    const phone = await phoneOfToken(tx, token);
    const [o] = await tx.select().from(onlineOrders).where(eq(onlineOrders.id, orderId)).for('update');
    if (!o || !phone || o.contactPhone !== phone) return fail('not_found');
    if (o.payMethod !== 'transfer' || !['awaiting_payment', 'proof_uploaded'].includes(o.status)) return fail('not_awaiting');
    await store.put(key, img.image.webp);
    if (o.proofKey) await store.remove(o.proofKey).catch(() => {});
    await tx.update(onlineOrders).set({ status: 'proof_uploaded', proofKey: key }).where(eq(onlineOrders.id, o.id));
    const [t] = await tx.select({ managerPhone: tenants.managerPhone, phone: tenants.phone }).from(tenants).where(eq(tenants.id, shop.id));
    const to = t.managerPhone ?? t.phone;
    if (to) await queue(tx, shop.id, { key: `online-proof:${o.id}:${key}`, kind: 'order', toPhone: to, body: `Order ${o.number}: the customer uploaded proof of payment. Check the money arrived, then confirm it.`, sendAfter: now });
    return { ok: true as const };
  });
}

// ---- staff side -------------------------------------------------------------

export async function listOnlineOrders(db: Db, ctx: Ctx, filter: 'open' | 'all' = 'open') {
  assertPermission(ctx, 'online_orders');
  return withTenant(db, ctx.tenantId, (tx) => tx.select({
    id: onlineOrders.id, number: onlineOrders.number, status: onlineOrders.status, source: onlineOrders.source, fulfilment: onlineOrders.fulfilment, contactName: onlineOrders.contactName,
    totalPesewas: onlineOrders.totalPesewas, payMethod: onlineOrders.payMethod, createdAt: onlineOrders.createdAt,
  }).from(onlineOrders).where(filter === 'open' ? inArray(onlineOrders.status, [...OPEN]) : undefined).orderBy(desc(onlineOrders.createdAt)).limit(200));
}

export async function getOnlineOrder(db: Db, ctx: Ctx, id: string) {
  assertPermission(ctx, 'online_orders');
  if (!isUuid(id)) return null;
  const [o] = await withTenant(db, ctx.tenantId, (tx) => tx.select().from(onlineOrders).where(eq(onlineOrders.id, id)));
  return o ?? null;
}

export async function orderProof(db: Db, store: ImageStore, ctx: Ctx, id: string): Promise<Uint8Array | null> {
  const o = await getOnlineOrder(db, ctx, id);
  return o?.proofKey ? store.get(o.proofKey) : null;
}

/** Staff saw the transfer arrive and enter its reference. */
export async function confirmTransfer(db: Db, ctx: Ctx, id: string, reference: string, now: Date): Promise<{ ok: true } | Fail<'not_found' | 'not_awaiting' | 'reference_required'>> {
  assertPermission(ctx, 'online_orders');
  const ref = reference?.trim().slice(0, 100);
  if (!ref) return fail('reference_required');
  if (!isUuid(id)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [o] = await tx.select().from(onlineOrders).where(eq(onlineOrders.id, id)).for('update');
    if (!o) return fail('not_found');
    if (o.payMethod !== 'transfer' || !(await markOrderPaid(tx, ctx.tenantId, o, { amountPesewas: o.totalPesewas, reference: ref }, now))) return fail('not_awaiting');
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'online_transfer_confirmed', recordType: 'online_order', recordId: o.id, changes: { reference: ref } });
    return { ok: true as const };
  });
}

const STEP_TEXT = { ready: 'is ready', out_for_delivery: 'is out for delivery' } as const;

/** Ready (pickup or delivery) and out for delivery; the customer gets an SMS each time. */
export async function setOnlineOrderStep(db: Db, ctx: Ctx, id: string, step: 'ready' | 'out_for_delivery', now: Date): Promise<{ ok: true } | Fail<'not_found' | 'not_allowed'>> {
  assertPermission(ctx, 'online_orders');
  if (!isUuid(id) || !(step in STEP_TEXT)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [o] = await tx.select().from(onlineOrders).where(eq(onlineOrders.id, id)).for('update');
    if (!o) return fail('not_found');
    const allowed = step === 'ready' ? o.status === 'confirmed' : o.fulfilment === 'delivery' && (o.status === 'confirmed' || o.status === 'ready');
    if (!allowed) return fail('not_allowed');
    await tx.update(onlineOrders).set({ status: step }).where(eq(onlineOrders.id, o.id));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: `online_order_${step}`, recordType: 'online_order', recordId: o.id });
    const extra = step === 'ready' && o.fulfilment === 'pickup' ? ' Come and collect it.' : '';
    await tell(tx, ctx.tenantId, o, step, `${await shopName(tx, ctx.tenantId)}: order ${o.number} ${STEP_TEXT[step]}.${extra}`, now);
    return { ok: true as const };
  });
}

/** Handed over: the paid order becomes a sale at this till; the reservation is released first so the sale takes that stock. */
export async function completeOnlineOrder(db: Db, ctx: Ctx, id: string, now: Date): Promise<{ ok: true; saleId: string } | Fail<string>> {
  assertPermission(ctx, 'online_orders');
  assertPermission(ctx, 'make_sale');
  if (!isUuid(id)) return fail('not_found');
  const r = await tillSale(db, ctx, async (tx, saleId, receiptNumber) => {
    const [o] = await tx.select().from(onlineOrders).where(eq(onlineOrders.id, id)).for('update');
    if (!o || !['confirmed', 'ready', 'out_for_delivery'].includes(o.status)) return throwSaleFailure({ ok: false, error: 'order_not_open' });
    await reserveStock(tx, ctx.tenantId, o.branchId, o.lines, -1);
    const paystack = o.payMethod === 'paystack';
    const sale = await completeSaleTx(tx, ctx, {
      saleId, receiptNumber, deviceCreatedAt: now.toISOString(),
      tenders: paystack ? [] : [{ id: randomUUID(), method: 'bank_transfer', amountPesewas: o.paidPesewas, reference: o.paymentReference ?? o.number }],
      lines: o.lines.map((l) => ({ variantId: l.variantId, unitId: l.unitId, quantity: l.quantity, unitPricePesewas: l.unitPricePesewas, discountPesewas: 0 })),
    }, now, { quotedPrices: true, ...(paystack ? { paystack: { reference: o.paymentReference ?? o.number, amountPesewas: o.paidPesewas } } : {}) });
    if (!sale.ok) return throwSaleFailure(sale);
    await tx.update(onlineOrders).set({ status: 'completed', saleId }).where(eq(onlineOrders.id, o.id));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'online_order_completed', recordType: 'online_order', recordId: o.id, changes: { saleId } });
    return { saleId, changeDuePesewas: 0 };
  });
  return r.ok ? { ok: true, saleId: r.saleId } : r;
}

/** Cancelled by the shop: stock goes back; money already paid is refunded outside the system (Paystack dashboard or transfer back). */
export async function cancelOnlineOrder(db: Db, ctx: Ctx, id: string, reason: string, now: Date): Promise<{ ok: true; refundDuePesewas: number } | Fail<'not_found' | 'not_open' | 'reason_required'>> {
  assertPermission(ctx, 'online_orders');
  const why = reason?.trim().slice(0, 200);
  if (!why) return fail('reason_required');
  if (!isUuid(id)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [o] = await tx.select().from(onlineOrders).where(eq(onlineOrders.id, id)).for('update');
    if (!o) return fail('not_found');
    if (!OPEN.includes(o.status)) return fail('not_open');
    await reserveStock(tx, ctx.tenantId, o.branchId, o.lines, -1);
    await tx.update(onlineOrders).set({ status: 'cancelled' }).where(eq(onlineOrders.id, o.id));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'online_order_cancelled', recordType: 'online_order', recordId: o.id, reason: why, changes: { refundDuePesewas: o.paidPesewas } });
    await tell(tx, ctx.tenantId, o, 'cancelled', `${await shopName(tx, ctx.tenantId)}: order ${o.number} was cancelled.${o.paidPesewas ? ' Your payment will be refunded.' : ''}`, now);
    return { ok: true as const, refundDuePesewas: o.paidPesewas };
  });
}

/** Cron: unpaid orders past their time lapse and their stock is released (a proof waiting for staff does not lapse). */
export async function expireOnlineOrders(db: Db, now: Date): Promise<number> {
  const due = await asPlatform(db, (tx) => tx.select({ id: onlineOrders.id, tenantId: onlineOrders.tenantId }).from(onlineOrders)
    .where(and(eq(onlineOrders.status, 'awaiting_payment'), sql`${onlineOrders.expiresAt} <= ${now.toISOString()}::timestamptz`)).limit(500));
  let n = 0;
  for (const d of due) {
    const done = await withTenant(db, d.tenantId, async (tx) => {
      const [o] = await tx.select().from(onlineOrders).where(eq(onlineOrders.id, d.id)).for('update');
      if (!o || o.status !== 'awaiting_payment') return false;
      await reserveStock(tx, d.tenantId, o.branchId, o.lines, -1);
      await tx.update(onlineOrders).set({ status: 'expired' }).where(eq(onlineOrders.id, o.id));
      await tell(tx, d.tenantId, o, 'expired', `${await shopName(tx, d.tenantId)}: order ${o.number} lapsed because it was not paid in time.`, now);
      return true;
    });
    if (done) n++;
  }
  return n;
}
