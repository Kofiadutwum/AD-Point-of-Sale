import 'server-only';
import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { type ChargeSale, onlineOrders, products, registers, sales, shopCharges, tenants, variants } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { pesewasTimesQty } from '@/lib/money';
import { applyPromotions } from '@/lib/promotions';
import { activePromotions } from './promotions';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { markOrderPaid } from './online-orders';
import { type Paystack, paystackWith, validSignature } from './paystack';
import { type Fail, fail } from './products';
import { priceCart, tillSale } from './quotes';
import { completeSaleTx, throwSaleFailure } from './sales';
import { openSecret, sealSecret } from './secret-box';

// Spec 6.11 and the Phase 6 decision: integrated payments use each shop's OWN Paystack account.
// The shop pastes its secret key (stored sealed); money settles straight to the shop and the platform never holds it.

export type ShopClient = (secretKey: string) => Paystack;
export const liveShopClient: ShopClient = (key) => paystackWith(() => key);

const KEY = /^sk_(test|live)_[A-Za-z0-9]{20,80}$/;
export const appUrl = () => process.env.APP_URL ?? 'http://localhost:3000';
const newReference = (prefix: 'T' | 'W') => `${prefix}-${randomBytes(12).toString('hex')}`;
/** Paystack needs an email; a till customer rarely gives one, so the charge uses a no-reply address on the platform's domain. */
export const chargeEmail = (reference: string) => `pay-${reference.toLowerCase()}@${new URL(appUrl()).hostname.replace(/^localhost$/, 'example.com')}`;

export async function shopSecretKey(tx: Tx, tenantId: string): Promise<string | null> {
  const [t] = await tx.select({ sealed: tenants.paystackSecretSealed }).from(tenants).where(eq(tenants.id, tenantId));
  return t?.sealed ? openSecret(t.sealed) : null;
}

/** Whether this shop has connected Paystack, so the till offers it. */
export async function tillPaystackReady(db: Db, ctx: Ctx): Promise<boolean> {
  return withTenant(db, ctx.tenantId, async (tx) => !!(await tx.select({ s: tenants.paystackSecretSealed }).from(tenants).where(eq(tenants.id, ctx.tenantId)))[0]?.s);
}

export async function shopPaystackStatus(db: Db, ctx: Ctx): Promise<{ connected: boolean; hint: string | null; webhookUrl: string }> {
  assertPermission(ctx, 'manage_integrations');
  const [t] = await withTenant(db, ctx.tenantId, (tx) => tx.select({ hint: tenants.paystackKeyHint, sealed: tenants.paystackSecretSealed }).from(tenants).where(eq(tenants.id, ctx.tenantId)));
  return { connected: !!t?.sealed, hint: t?.hint ?? null, webhookUrl: `${appUrl()}/api/${ctx.slug}/paystack/webhook` };
}

/** The owner pastes the shop's Paystack secret key (or clears it); it is sealed at rest and never shown again. */
export async function saveShopPaystackKey(db: Db, ctx: Ctx, key: string | null): Promise<{ ok: true } | Fail<'invalid_key'>> {
  assertPermission(ctx, 'manage_integrations');
  const k = key?.trim() ?? '';
  if (k && !KEY.test(k)) return fail('invalid_key');
  await withTenant(db, ctx.tenantId, async (tx) => {
    await tx.update(tenants).set({ paystackSecretSealed: k ? sealSecret(k) : null, paystackKeyHint: k ? `${k.slice(0, 8)}…${k.slice(-4)}` : null }).where(eq(tenants.id, ctx.tenantId));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: k ? 'paystack_key_saved' : 'paystack_key_removed', changes: k ? { mode: k.startsWith('sk_live_') ? 'live' : 'test' } : undefined });
  });
  return { ok: true };
}

type TillLine = { variantId: string; unitId: string; quantity: string; discountPesewas?: number };
export type ChargeError = 'invalid_input' | 'not_connected' | 'no_register' | 'unknown_item' | 'discount_not_allowed' | 'provider_unavailable';

/** Spec 4.3: the till starts a Paystack charge (card or MoMo on the customer's phone); the sale is made only once Paystack confirms it. */
export async function startTillCharge(db: Db, ctx: Ctx, input: { customerId?: string | null; lines: TillLine[] }, now: Date, client: ShopClient = liveShopClient): Promise<
  { ok: true; reference: string; authorizationUrl: string; amountPesewas: number } | Fail<ChargeError>
> {
  assertPermission(ctx, 'make_sale');
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 200) return fail('invalid_input');
  const lines = input.lines.map((l) => ({ variantId: String(l.variantId), unitId: String(l.unitId), quantity: String(l.quantity), discountPesewas: Number.isInteger(l.discountPesewas) && l.discountPesewas! > 0 ? l.discountPesewas! : 0 }));
  if (lines.some((l) => l.discountPesewas > 0) && !ctx.permissions.includes('give_discount')) return fail('discount_not_allowed');
  if (!ctx.registerId) return fail('no_register');
  const registerId = ctx.registerId;
  const reference = newReference('T');
  const prep = await withTenant(db, ctx.tenantId, async (tx) => {
    const key = await shopSecretKey(tx, ctx.tenantId);
    if (!key) return fail('not_connected');
    const [reg] = await tx.select({ branchId: registers.branchId }).from(registers).where(eq(registers.id, registerId));
    if (!reg) return fail('no_register');
    let priced;
    try { priced = await priceCart(tx, ctx, reg.branchId, input.customerId ?? null, lines, now); } catch { priced = null; }
    if (!priced || priced.totalPesewas <= 0) return fail('unknown_item');
    // spec 6.29: the sale is made with these prices as quoted, so running promotions are folded into each line's discount now (as the till showed them)
    const [shop] = await tx.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const promos = await activePromotions(tx, reg.branchId, shop.timezone, now);
    if (promos.length) {
      const meta = await tx.select({ id: variants.id, productId: variants.productId, categoryId: products.categoryId, giftCard: variants.isGiftCard }).from(variants)
        .innerJoin(products, eq(products.id, variants.productId)).where(inArray(variants.id, priced.lines.map((l) => l.variantId)));
      const promo = applyPromotions(priced.lines.map((l, i) => {
        const m = meta.find((x) => x.id === l.variantId)!;
        const gross = m.giftCard ? 0 : pesewasTimesQty(l.unitPricePesewas, l.quantity);
        return { productId: m.productId, categoryId: m.categoryId, unitPricePesewas: m.giftCard ? 0 : l.unitPricePesewas, quantity: l.quantity, grossPesewas: gross, manualDiscountPesewas: lines[i].discountPesewas };
      }), promos).discounts;
      if (promo.some((d) => d > 0)) {
        try { priced = await priceCart(tx, ctx, reg.branchId, input.customerId ?? null, lines.map((l, i) => ({ ...l, discountPesewas: l.discountPesewas + promo[i] })), now); } catch { priced = null; }
        if (!priced || priced.totalPesewas <= 0) return fail('unknown_item');
      }
    }
    const sale: ChargeSale = {
      registerId, userId: ctx.userId, customerId: input.customerId ?? null,
      lines: priced.lines.map((l) => ({ variantId: l.variantId, unitId: l.unitId, quantity: l.quantity, unitPricePesewas: l.unitPricePesewas, discountPesewas: l.discountPesewas })),
    };
    await tx.insert(shopCharges).values({ tenantId: ctx.tenantId, reference, purpose: 'till', amountPesewas: priced.totalPesewas, sale });
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'paystack_charge_started', recordType: 'shop_charge', changes: { reference, amountPesewas: priced.totalPesewas } });
    return { ok: true as const, key, amountPesewas: priced.totalPesewas };
  });
  if (!prep.ok) return prep;
  try {
    const { authorizationUrl } = await client(prep.key).initialize({
      email: chargeEmail(reference), amountPesewas: prep.amountPesewas, reference, callbackUrl: `${appUrl()}/${ctx.slug}/paid`, metadata: { purpose: 'till', registerId },
    });
    await withTenant(db, ctx.tenantId, (tx) => tx.update(shopCharges).set({ authorizationUrl }).where(eq(shopCharges.reference, reference)));
    return { ok: true, reference, authorizationUrl, amountPesewas: prep.amountPesewas };
  } catch {
    await withTenant(db, ctx.tenantId, (tx) => tx.update(shopCharges).set({ status: 'failed' }).where(eq(shopCharges.reference, reference)));
    return fail('provider_unavailable');
  }
}

/** Opens a Paystack checkout for an online order on the shop's account (6.49). */
export async function startOrderCharge(db: Db, tenantId: string, slug: string, order: { id: string; number: string; totalPesewas: number }, client: ShopClient = liveShopClient): Promise<string | null> {
  const reference = newReference('W');
  const key = await withTenant(db, tenantId, async (tx) => {
    const k = await shopSecretKey(tx, tenantId);
    if (k) await tx.insert(shopCharges).values({ tenantId, reference, purpose: 'online_order', amountPesewas: order.totalPesewas, orderId: order.id });
    return k;
  });
  if (!key) return null;
  try {
    const { authorizationUrl } = await client(key).initialize({
      email: chargeEmail(reference), amountPesewas: order.totalPesewas, reference, callbackUrl: `${appUrl()}/${slug}/order/${order.id}`, metadata: { purpose: 'online_order', order: order.number },
    });
    await withTenant(db, tenantId, (tx) => tx.update(shopCharges).set({ authorizationUrl }).where(eq(shopCharges.reference, reference)));
    return authorizationUrl;
  } catch {
    await withTenant(db, tenantId, (tx) => tx.update(shopCharges).set({ status: 'failed' }).where(eq(shopCharges.reference, reference)));
    return null;
  }
}

export type ChargeOutcome = 'unknown' | 'pending' | 'failed' | 'mismatch' | 'completed' | { paidNotRecorded: string };

/**
 * Spec 6.11: Paystack's verify endpoint decides (a webhook alone is never trusted); amount and currency must match.
 * A till charge becomes its sale and the charge is marked paid in the same transaction, so it completes exactly once.
 * If the sale is refused after the money arrived (e.g. no open shift), the charge stays pending and is retried on the next check or webhook.
 */
export async function applyShopCharge(db: Db, tenantId: string, reference: string, now: Date, client: ShopClient = liveShopClient): Promise<{ outcome: ChargeOutcome; saleId?: string }> {
  const loaded = await withTenant(db, tenantId, async (tx) => {
    const [c] = await tx.select().from(shopCharges).where(eq(shopCharges.reference, reference));
    const [t] = await tx.select({ slug: tenants.slug, timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId));
    return c ? { c, key: await shopSecretKey(tx, tenantId), shop: t } : null;
  });
  if (!loaded) return { outcome: 'unknown' };
  const { c, key, shop } = loaded;
  if (c.status === 'success') return { outcome: 'completed', saleId: c.saleId ?? undefined };
  if (c.status !== 'pending') return { outcome: c.status };
  if (!key) return { outcome: 'pending' };
  let v;
  try { v = await client(key).verify(reference); } catch { return { outcome: 'pending' }; }
  if (v.status !== 'success') {
    if (['ongoing', 'pending', 'processing', 'queued', 'send_otp', 'abandoned'].includes(v.status)) return { outcome: 'pending' };
    await withTenant(db, tenantId, (tx) => tx.update(shopCharges).set({ status: 'failed' }).where(and(eq(shopCharges.id, c.id), eq(shopCharges.status, 'pending'))));
    return { outcome: 'failed' };
  }
  if (v.amount !== c.amountPesewas || v.currency !== 'GHS' || v.reference !== reference) {
    await withTenant(db, tenantId, async (tx) => {
      await tx.update(shopCharges).set({ status: 'mismatch' }).where(eq(shopCharges.id, c.id));
      await writeAudit(tx, { tenantId, actorType: 'system', actorId: null, action: 'paystack_charge_mismatch', reason: 'amount or currency differ', changes: { reference, expected: c.amountPesewas, paid: v.amount, currency: v.currency } });
    });
    return { outcome: 'mismatch' };
  }
  const channel = v.channel ?? null;

  if (c.purpose === 'online_order') {
    await withTenant(db, tenantId, async (tx) => {
      const [locked] = await tx.select().from(shopCharges).where(eq(shopCharges.id, c.id)).for('update');
      if (locked.status !== 'pending') return;
      await tx.update(shopCharges).set({ status: 'success', channel, completedAt: now }).where(eq(shopCharges.id, c.id));
      const [o] = await tx.select().from(onlineOrders).where(eq(onlineOrders.id, c.orderId!)).for('update');
      if (o) await markOrderPaid(tx, tenantId, o, { amountPesewas: c.amountPesewas, reference }, now);
    });
    return { outcome: 'completed' };
  }

  const sale = c.sale!;
  // the sale is made as the cashier who started the charge, at that till; prices and discounts were checked then
  const ctx: Ctx = {
    tenantId, slug: shop.slug, timezone: shop.timezone, userId: sale.userId, name: '', rolePreset: 'cashier', permissions: ['make_sale'],
    registerId: sale.registerId, subscription: 'active', sessionId: '', sessionKind: 'pin',
  };
  const r = await tillSale(db, ctx, async (tx, saleId, receiptNumber) => {
    const [locked] = await tx.select().from(shopCharges).where(eq(shopCharges.id, c.id)).for('update');
    if (locked.status !== 'pending') return throwSaleFailure({ ok: false, error: 'order_not_open' });
    const done = await completeSaleTx(tx, ctx, {
      saleId, receiptNumber, deviceCreatedAt: now.toISOString(), customerId: sale.customerId ?? undefined, tenders: [], lines: sale.lines,
    }, now, { quotedPrices: true, paystack: { reference, amountPesewas: c.amountPesewas } });
    if (!done.ok) return throwSaleFailure(done);
    await tx.update(shopCharges).set({ status: 'success', channel, saleId, completedAt: now }).where(eq(shopCharges.id, c.id));
    return { saleId, changeDuePesewas: 0 };
  });
  if (r.ok) return { outcome: 'completed', saleId: r.saleId };
  if (r.error === 'order_not_open') { // another check completed it first
    const [again] = await withTenant(db, tenantId, (tx) => tx.select({ saleId: shopCharges.saleId }).from(shopCharges).where(eq(shopCharges.id, c.id)));
    return { outcome: 'completed', saleId: again?.saleId ?? undefined };
  }
  return { outcome: { paidNotRecorded: r.error } };
}

/** The till polls its charge; the cashier's own shop only. */
export async function checkTillCharge(db: Db, ctx: Ctx, reference: string, now: Date, client: ShopClient = liveShopClient) {
  assertPermission(ctx, 'make_sale');
  if (!/^T-[0-9a-f]{24}$/.test(reference)) return { outcome: 'unknown' as const };
  const r = await applyShopCharge(db, ctx.tenantId, reference, now, client);
  if (!r.saleId) return r;
  const [s] = await withTenant(db, ctx.tenantId, (tx) => tx.select({ receiptNumber: sales.receiptNumber }).from(sales).where(eq(sales.id, r.saleId!)));
  return { ...r, receiptNumber: s?.receiptNumber };
}

/** Spec 6.11: Paystack posts the shop's own events here; the signature is checked with that shop's key on the raw bytes. */
export async function handleShopWebhook(db: Db, slug: string, raw: Uint8Array, signature: string | null, now: Date, client: ShopClient = liveShopClient): Promise<{ status: 200 | 400 | 401 | 404 }> {
  const shop = await asPlatform(db, async (tx) => (await tx.select({ id: tenants.id, sealed: tenants.paystackSecretSealed }).from(tenants).where(eq(tenants.slug, slug)))[0]);
  const key = shop?.sealed ? openSecret(shop.sealed) : null;
  if (!shop || !key) return { status: 404 };
  if (!validSignature(raw, signature, key)) return { status: 401 };
  let event: { event?: string; data?: { reference?: string } };
  try { event = JSON.parse(Buffer.from(raw).toString('utf8')); } catch { return { status: 400 }; }
  const reference = event.data?.reference;
  if ((event.event === 'charge.success' || event.event === 'charge.failed') && typeof reference === 'string') await applyShopCharge(db, shop.id, reference, now, client);
  return { status: 200 };
}

/** The visitor came back from Paystack checkout: verify now rather than wait for the webhook (both are safe to repeat). */
export async function confirmOrderReturn(db: Db, slug: string, reference: string, now: Date, client: ShopClient = liveShopClient): Promise<void> {
  if (!/^W-[0-9a-f]{24}$/.test(reference)) return;
  const [shop] = await asPlatform(db, (tx) => tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)));
  if (shop) await applyShopCharge(db, shop.id, reference, now, client);
}
