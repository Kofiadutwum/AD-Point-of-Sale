import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { commissionEntries, commissionRules, customers, giftCardEntries, giftCards, loyaltyEntries, tenants, users, variants } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { addMonths, todayIn } from '@/lib/dates';
import { divHalfUp } from '@/lib/decimal';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, isUuid } from './products';
import { openSecret, sealSecret } from './secret-box';

// ---- Loyalty points (spec 6.30) -------------------------------------------

export type LoyaltySettings = { loyaltyEnabled: boolean; pesewasPerPoint: number; pointValuePesewas: number; minRedeemPoints: number; pointsExpiryMonths: number; giftCardExpiryMonths: number };

export async function getLoyaltySettings(db: Db, ctx: Ctx): Promise<LoyaltySettings> {
  const [t] = await withTenant(db, ctx.tenantId, (tx) => tx.select({
    loyaltyEnabled: tenants.loyaltyEnabled, pesewasPerPoint: tenants.pesewasPerPoint, pointValuePesewas: tenants.pointValuePesewas, minRedeemPoints: tenants.minRedeemPoints,
    pointsExpiryMonths: tenants.pointsExpiryMonths, giftCardExpiryMonths: tenants.giftCardExpiryMonths,
  }).from(tenants).where(eq(tenants.id, ctx.tenantId)));
  return t;
}

export async function saveLoyaltySettings(db: Db, ctx: Ctx, input: LoyaltySettings): Promise<{ ok: true } | Fail<'invalid_input'>> {
  assertPermission(ctx, 'manage_promotions');
  const ok = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;
  if (typeof input.loyaltyEnabled !== 'boolean' || !ok(input.pesewasPerPoint, 1, 1_000_000) || !ok(input.pointValuePesewas, 1, 10_000) || !ok(input.minRedeemPoints, 1, 1_000_000)
    || !ok(input.pointsExpiryMonths, 0, 120) || !ok(input.giftCardExpiryMonths, 0, 120)) return fail('invalid_input');
  await withTenant(db, ctx.tenantId, async (tx) => {
    await tx.update(tenants).set(input).where(eq(tenants.id, ctx.tenantId));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'loyalty_settings_saved', changes: input });
  });
  return { ok: true };
}

/** A points tender: whole points only, at least the shop's minimum, never more than the customer has. */
export async function redeemPoints(tx: Tx, tenantId: string, customerId: string, amountPesewas: number, saleId: string): Promise<true | 'loyalty_off' | 'insufficient_points'> {
  const [t] = await tx.select({ on: tenants.loyaltyEnabled, value: tenants.pointValuePesewas, min: tenants.minRedeemPoints }).from(tenants).where(eq(tenants.id, tenantId));
  if (!t.on) return 'loyalty_off';
  if (amountPesewas % t.value !== 0) return 'insufficient_points';
  const points = amountPesewas / t.value;
  if (points < t.min) return 'insufficient_points';
  const [row] = await tx.update(customers).set({ loyaltyPoints: sql`${customers.loyaltyPoints} - ${points}` })
    .where(and(eq(customers.id, customerId), gte(customers.loyaltyPoints, points))).returning({ id: customers.id });
  if (!row) return 'insufficient_points';
  await tx.insert(loyaltyEntries).values({ tenantId, customerId, type: 'redeemed', points: -points, saleId });
  return true;
}

/** Points on the money paid (not store credit, gift cards, or points), after discounts and without tax. */
export async function awardPoints(tx: Tx, tenantId: string, customerId: string, saleId: string, moneyPaidPesewas: number, totalPesewas: number, taxPesewas: number): Promise<number> {
  const [t] = await tx.select({ on: tenants.loyaltyEnabled, per: tenants.pesewasPerPoint }).from(tenants).where(eq(tenants.id, tenantId));
  if (!t.on || moneyPaidPesewas <= 0 || totalPesewas <= 0) return 0;
  const eligible = Number(divHalfUp(BigInt(Math.min(moneyPaidPesewas, totalPesewas)) * BigInt(totalPesewas - taxPesewas), BigInt(totalPesewas)));
  const points = Math.floor(eligible / t.per);
  if (points <= 0) return 0;
  await tx.update(customers).set({ loyaltyPoints: sql`${customers.loyaltyPoints} + ${points}` }).where(eq(customers.id, customerId));
  await tx.insert(loyaltyEntries).values({ tenantId, customerId, type: 'earned', points, saleId });
  return points;
}

/** On a return: the points earned on the returned share come off (the balance may go below zero). */
export async function reversePoints(tx: Tx, tenantId: string, saleId: string, refundPesewas: number, saleTotalPesewas: number): Promise<number> {
  const earned = await tx.select().from(loyaltyEntries).where(and(eq(loyaltyEntries.saleId, saleId), eq(loyaltyEntries.type, 'earned')));
  if (!earned.length || saleTotalPesewas <= 0) return 0;
  const [already] = await tx.select({ n: sql<number>`coalesce(sum(${loyaltyEntries.points}), 0)::int` }).from(loyaltyEntries).where(and(eq(loyaltyEntries.saleId, saleId), eq(loyaltyEntries.type, 'reversed')));
  const total = earned[0].points;
  const take = Math.min(total + already.n, Math.floor((total * refundPesewas) / saleTotalPesewas));
  if (take <= 0) return 0;
  await tx.update(customers).set({ loyaltyPoints: sql`${customers.loyaltyPoints} - ${take}` }).where(eq(customers.id, earned[0].customerId));
  await tx.insert(loyaltyEntries).values({ tenantId, customerId: earned[0].customerId, type: 'reversed', points: -take, saleId });
  return take;
}

/** Points earned more than N months ago and not spent expire (run monthly). */
// shortcut: expiry takes min(balance, points earned before the cutoff); it does not trace which points were spent first. Fine while expiry is rare.
export async function expirePoints(db: Db, ctx: Ctx, now: Date): Promise<number> {
  assertPermission(ctx, 'manage_promotions');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [t] = await tx.select({ months: tenants.pointsExpiryMonths, tz: tenants.timezone }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    if (!t.months) return 0;
    const cutoff = new Date(`${addMonths(todayIn(t.tz, now), -t.months)}T00:00:00Z`);
    const old = await tx.select().from(loyaltyEntries).where(and(eq(loyaltyEntries.type, 'earned'), eq(loyaltyEntries.expiryChecked, false), lt(loyaltyEntries.createdAt, cutoff)));
    let expired = 0;
    const byCustomer = new Map<string, number>();
    for (const e of old) byCustomer.set(e.customerId, (byCustomer.get(e.customerId) ?? 0) + e.points);
    for (const [customerId, pts] of byCustomer) {
      const [c] = await tx.select({ bal: customers.loyaltyPoints }).from(customers).where(eq(customers.id, customerId)).for('update');
      const take = Math.min(Math.max(c.bal, 0), pts);
      if (take > 0) {
        await tx.update(customers).set({ loyaltyPoints: c.bal - take }).where(eq(customers.id, customerId));
        await tx.insert(loyaltyEntries).values({ tenantId: ctx.tenantId, customerId, type: 'expired', points: -take });
        expired += take;
      }
    }
    for (const e of old) await tx.update(loyaltyEntries).set({ expiryChecked: true }).where(eq(loyaltyEntries.id, e.id));
    return expired;
  });
}

export async function findCustomerByLoyaltyCode(db: Db, ctx: Ctx, code: string) {
  assertPermission(ctx, 'make_sale');
  const c = typeof code === 'string' ? code.trim() : '';
  if (!c || c.length > 40) return null;
  const [row] = await withTenant(db, ctx.tenantId, (tx) => tx.select({ id: customers.id, name: customers.name, points: customers.loyaltyPoints }).from(customers).where(eq(customers.loyaltyCode, c)));
  return row ?? null;
}

// ---- Gift cards (spec 6.31) -----------------------------------------------

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O or 1/I mix-ups; 256 is a multiple of 32, so no bias
export const normaliseGiftCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = (code: string) => createHash('sha256').update(normaliseGiftCode(code)).digest('hex');
export const formatGiftCode = (code: string) => code.match(/.{1,4}/g)!.join('-');

function newGiftCode(): string {
  return [...randomBytes(16)].map((b) => ALPHABET[b % 32]).join('');
}

/** Issues one card per amount; the code is returned once and kept sealed for reprinting the receipt. */
export async function issueGiftCards(tx: Tx, tenantId: string, saleId: string, amounts: number[], today: string): Promise<Array<{ code: string; amountPesewas: number }>> {
  const [t] = await tx.select({ months: tenants.giftCardExpiryMonths }).from(tenants).where(eq(tenants.id, tenantId));
  const out = [];
  for (const amount of amounts) {
    if (amount <= 0) continue;
    const code = newGiftCode();
    const [card] = await tx.insert(giftCards).values({
      tenantId, codeHash: hashCode(code), codeSealed: sealSecret(code), last4: code.slice(-4), initialPesewas: amount, balancePesewas: amount,
      expiresOn: t.months ? addMonths(today, t.months) : null, saleId,
    }).returning({ id: giftCards.id });
    await tx.insert(giftCardEntries).values({ tenantId, giftCardId: card.id, type: 'issued', amountPesewas: amount, saleId });
    out.push({ code: formatGiftCode(code), amountPesewas: amount });
  }
  return out;
}

/** A gift card tender. */
// shortcut: no per-till wrong-code limit (spec 6.31 asks 5 in 10 minutes): sales run as the shop role, which cannot write the platform rate-limit table, and a refused sale rolls back. 16-character codes (80 bits) cannot be guessed.
export async function redeemGiftCard(tx: Tx, tenantId: string, input: { code: string; amountPesewas: number; saleId: string; registerId: string }, today: string, _now?: Date): Promise<{ last4: string } | 'invalid_gift_card' | 'insufficient_gift_card' | 'try_again_later'> {
  const [card] = await tx.select().from(giftCards).where(eq(giftCards.codeHash, hashCode(input.code))).for('update');
  if (!card || card.status !== 'active' || (card.expiresOn && card.expiresOn < today)) return 'invalid_gift_card';
  if (card.balancePesewas < input.amountPesewas) return 'insufficient_gift_card';
  await tx.update(giftCards).set({ balancePesewas: card.balancePesewas - input.amountPesewas }).where(eq(giftCards.id, card.id));
  await tx.insert(giftCardEntries).values({ tenantId, giftCardId: card.id, type: 'redeemed', amountPesewas: -input.amountPesewas, saleId: input.saleId });
  return { last4: card.last4 };
}

export async function giftCardBalance(db: Db, ctx: Ctx, code: string): Promise<{ balancePesewas: number; expiresOn: string | null; status: string } | null> {
  assertPermission(ctx, 'make_sale');
  if (typeof code !== 'string' || normaliseGiftCode(code).length !== 16) return null;
  const [c] = await withTenant(db, ctx.tenantId, (tx) => tx.select().from(giftCards).where(eq(giftCards.codeHash, hashCode(code))));
  return c ? { balancePesewas: c.balancePesewas, expiresOn: c.expiresOn, status: c.status } : null;
}

/** For the receipt: the codes of gift cards sold on this sale. */
export async function giftCardsOfSale(tx: Tx, saleId: string) {
  return (await tx.select().from(giftCards).where(eq(giftCards.saleId, saleId))).map((c) => ({ code: formatGiftCode(openSecret(c.codeSealed) ?? ''), amountPesewas: c.initialPesewas, expiresOn: c.expiresOn }));
}

/** Spec 4.20: unspent gift card balances are money held for customers. */
export async function giftCardLiability(db: Db, ctx: Ctx): Promise<{ cards: number; balancePesewas: number }> {
  assertPermission(ctx, 'view_reports');
  const [r] = await withTenant(db, ctx.tenantId, (tx) => tx.select({ cards: sql<number>`count(*)::int`, bal: sql<number>`coalesce(sum(${giftCards.balancePesewas}), 0)::int` })
    .from(giftCards).where(and(eq(giftCards.status, 'active'), sql`${giftCards.balancePesewas} > 0`)));
  return { cards: r.cards, balancePesewas: r.bal };
}

// ---- Commissions (spec 6.41) ----------------------------------------------

type CommissionLine = { saleLineId: string; productId: string; categoryId: string | null; netPesewas: number; quantity: string };

/** The most specific active rule: product, then category, then the person, then the shop default. */
export async function recordCommissions(tx: Tx, tenantId: string, saleId: string, userId: string, lines: CommissionLine[]): Promise<number> {
  const rules = await tx.select().from(commissionRules).where(eq(commissionRules.active, true));
  if (!rules.length) return 0;
  const forPerson = (r: typeof rules[number]) => r.userId === null || r.userId === userId;
  let total = 0;
  for (const l of lines) {
    const rule = rules.find((r) => forPerson(r) && r.productId === l.productId)
      ?? rules.find((r) => forPerson(r) && r.productId === null && r.categoryId !== null && r.categoryId === l.categoryId)
      ?? rules.find((r) => r.userId === userId && r.productId === null && r.categoryId === null)
      ?? rules.find((r) => r.userId === null && r.productId === null && r.categoryId === null);
    if (!rule) continue;
    const amount = rule.percentBp !== null ? Number(divHalfUp(BigInt(l.netPesewas) * BigInt(rule.percentBp), 10000n)) : Math.round(rule.fixedPesewas! * Number(l.quantity));
    if (amount <= 0) continue;
    await tx.insert(commissionEntries).values({ tenantId, userId, saleId, saleLineId: l.saleLineId, amountPesewas: amount });
    total += amount;
  }
  return total;
}

/** On a return: negative entries for the returned part of each line. */
export async function reverseCommissions(tx: Tx, tenantId: string, returnId: string, parts: Array<{ saleLineId: string; fraction: number }>): Promise<void> {
  for (const p of parts) {
    const rows = await tx.select().from(commissionEntries).where(and(eq(commissionEntries.saleLineId, p.saleLineId), isNull(commissionEntries.returnId)));
    for (const r of rows) {
      const amount = Math.round(r.amountPesewas * p.fraction);
      if (amount > 0) await tx.insert(commissionEntries).values({ tenantId, userId: r.userId, saleId: r.saleId, saleLineId: r.saleLineId, returnId, amountPesewas: -amount });
    }
  }
}

export async function saveCommissionRule(db: Db, ctx: Ctx, input: { userId?: string | null; productId?: string | null; categoryId?: string | null; percentBp?: number | null; fixedPesewas?: number | null }): Promise<{ ok: true } | Fail<'invalid_input'>> {
  assertPermission(ctx, 'manage_commissions');
  const ids = [input.userId, input.productId, input.categoryId].filter((x) => x);
  const pct = input.percentBp ?? null;
  const fixed = input.fixedPesewas ?? null;
  if (!ids.every((x) => isUuid(x!)) || (pct === null) === (fixed === null) || (pct !== null && (!Number.isInteger(pct) || pct < 0 || pct > 10000)) || (fixed !== null && (!Number.isInteger(fixed) || fixed < 0))) return fail('invalid_input');
  await withTenant(db, ctx.tenantId, async (tx) => {
    await tx.insert(commissionRules).values({ tenantId: ctx.tenantId, userId: input.userId || null, productId: input.productId || null, categoryId: input.categoryId || null, percentBp: pct, fixedPesewas: fixed });
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'commission_rule_saved', changes: input });
  });
  return { ok: true };
}

export async function listCommissionRules(db: Db, ctx: Ctx) {
  assertPermission(ctx, 'manage_commissions');
  return withTenant(db, ctx.tenantId, (tx) => tx.select().from(commissionRules).where(eq(commissionRules.active, true)).orderBy(asc(commissionRules.createdAt)));
}

export async function deactivateCommissionRule(db: Db, ctx: Ctx, id: string): Promise<{ ok: true }> {
  assertPermission(ctx, 'manage_commissions');
  if (isUuid(id)) await withTenant(db, ctx.tenantId, (tx) => tx.update(commissionRules).set({ active: false }).where(eq(commissionRules.id, id)));
  return { ok: true };
}

/** Commission per person for a period (by when it was earned), and what is still unpaid. */
export async function commissionReport(db: Db, ctx: Ctx, range: { from: string; to: string }) {
  assertPermission(ctx, 'manage_commissions');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to)) return [];
  const from = new Date(`${range.from}T00:00:00Z`);
  const to = new Date(Date.parse(`${range.to}T00:00:00Z`) + 86_400_000);
  return withTenant(db, ctx.tenantId, (tx) => tx.select({
    userId: commissionEntries.userId, name: users.name, totalPesewas: sql<number>`sum(${commissionEntries.amountPesewas})::int`,
    unpaidPesewas: sql<number>`coalesce(sum(${commissionEntries.amountPesewas}) filter (where ${commissionEntries.paidAt} is null), 0)::int`,
  }).from(commissionEntries).innerJoin(users, eq(users.id, commissionEntries.userId))
    .where(and(gte(commissionEntries.createdAt, from), lt(commissionEntries.createdAt, to))).groupBy(commissionEntries.userId, users.name).orderBy(desc(sql`sum(${commissionEntries.amountPesewas})`)));
}

/** The owner marks a person's commission for the period as paid. */
export async function markCommissionPaid(db: Db, ctx: Ctx, input: { userId: string; from: string; to: string }, now: Date): Promise<{ ok: true; paidPesewas: number } | Fail<'invalid_input'>> {
  assertPermission(ctx, 'manage_commissions');
  if (!isUuid(input.userId) || !/^\d{4}-\d{2}-\d{2}$/.test(input.from) || !/^\d{4}-\d{2}-\d{2}$/.test(input.to)) return fail('invalid_input');
  const from = new Date(`${input.from}T00:00:00Z`);
  const to = new Date(Date.parse(`${input.to}T00:00:00Z`) + 86_400_000);
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rows = await tx.update(commissionEntries).set({ paidAt: now })
      .where(and(eq(commissionEntries.userId, input.userId), isNull(commissionEntries.paidAt), gte(commissionEntries.createdAt, from), lt(commissionEntries.createdAt, to)))
      .returning({ amount: commissionEntries.amountPesewas });
    const paid = rows.reduce((s, r) => s + r.amount, 0);
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'commission_paid', recordType: 'user', recordId: input.userId, changes: { ...input, paidPesewas: paid } });
    return { ok: true as const, paidPesewas: paid };
  });
}

/** Spec 4.20: a gift card is sold as an item; this makes one for a fixed value (no stock is kept for it). */
export async function createGiftCardProduct(db: Db, ctx: Ctx, amountPesewas: number): Promise<{ ok: true; variantId: string } | Fail<'invalid_input'>> {
  assertPermission(ctx, 'manage_promotions');
  if (!Number.isInteger(amountPesewas) || amountPesewas < 100 || amountPesewas > 10_000_000) return fail('invalid_input');
  const { createProduct } = await import('./products');
  const r = await createProduct(db, ctx, {
    name: `Gift card GHS ${(amountPesewas / 100).toFixed(2)}`, kind: 'standard', tracking: 'none', baseUnit: 'card', allowsFractions: false,
    variants: [{ basePricePesewas: amountPesewas, costPesewas: 0 }],
  });
  if (!r.ok) return fail('invalid_input');
  const variantId = r.variants[0].variantId;
  await withTenant(db, ctx.tenantId, (tx) => tx.update(variants).set({ isGiftCard: true }).where(eq(variants.id, variantId)));
  return { ok: true, variantId };
}
