import 'server-only';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { couponUses, coupons, type PromotionKind, promotions } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { type Promo, promoRunning } from '@/lib/promotions';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, isUuid } from './products';

const KINDS: readonly PromotionKind[] = ['percent_off', 'amount_off', 'buy_x_get_y', 'multi_buy', 'cart_percent', 'cart_amount'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export type PromotionInput = {
  id?: string; name: string; kind: PromotionKind; productIds?: string[]; categoryIds?: string[];
  percentBp?: number | null; amountPesewas?: number | null; buyQty?: number | null; getQty?: number | null; groupQty?: number | null; groupPricePesewas?: number | null;
  minSubtotalPesewas?: number; startsOn?: string | null; endsOn?: string | null; days?: number[]; startTime?: string | null; endTime?: string | null;
  branchIds?: string[]; stackable?: boolean; requiresCoupon?: boolean; active?: boolean;
};

const int = (v: unknown, min: number, max: number) => v === null || v === undefined || (Number.isInteger(v) && (v as number) >= min && (v as number) <= max);

/** Each kind needs its own numbers: percent for percent kinds, amount for amount kinds, quantities for group kinds. */
function validPromotion(p: PromotionInput): boolean {
  if (!p.name?.trim() || p.name.trim().length > 80 || !KINDS.includes(p.kind)) return false;
  if (!int(p.percentBp, 1, 10000) || !int(p.amountPesewas, 1, 100_000_000) || !int(p.buyQty, 1, 100) || !int(p.getQty, 1, 100) || !int(p.groupQty, 2, 100) || !int(p.groupPricePesewas, 0, 100_000_000) || !int(p.minSubtotalPesewas, 0, 100_000_000)) return false;
  const need: Record<PromotionKind, boolean> = {
    percent_off: !!p.percentBp, amount_off: !!p.amountPesewas, buy_x_get_y: !!p.buyQty && !!p.getQty, multi_buy: !!p.groupQty && p.groupPricePesewas != null, cart_percent: !!p.percentBp, cart_amount: !!p.amountPesewas,
  };
  if (!need[p.kind]) return false;
  if ([p.startsOn, p.endsOn].some((d) => d && !DAY.test(d)) || [p.startTime, p.endTime].some((t) => t && !TIME.test(t))) return false;
  if ((p.days ?? []).some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return false;
  return [...(p.productIds ?? []), ...(p.categoryIds ?? []), ...(p.branchIds ?? [])].every(isUuid);
}

export async function savePromotion(db: Db, ctx: Ctx, input: PromotionInput): Promise<{ ok: true; promotionId: string } | Fail<'invalid_input' | 'not_found'>> {
  assertPermission(ctx, 'manage_promotions');
  if (!validPromotion(input)) return fail('invalid_input');
  const values = {
    name: input.name.trim(), kind: input.kind, productIds: input.productIds ?? [], categoryIds: input.categoryIds ?? [],
    percentBp: input.kind === 'buy_x_get_y' ? (input.percentBp ?? 10000) : (input.percentBp ?? null), amountPesewas: input.amountPesewas ?? null,
    buyQty: input.buyQty ?? null, getQty: input.getQty ?? null, groupQty: input.groupQty ?? null, groupPricePesewas: input.groupPricePesewas ?? null,
    minSubtotalPesewas: input.minSubtotalPesewas ?? 0, startsOn: input.startsOn || null, endsOn: input.endsOn || null, days: input.days ?? [],
    startTime: input.startTime || null, endTime: input.endTime || null, branchIds: input.branchIds ?? [], stackable: input.stackable === true,
    requiresCoupon: input.requiresCoupon === true, active: input.active !== false,
  };
  return withTenant(db, ctx.tenantId, async (tx) => {
    let id = input.id;
    if (id) {
      if (!isUuid(id)) return fail('not_found');
      const [u] = await tx.update(promotions).set(values).where(eq(promotions.id, id)).returning({ id: promotions.id });
      if (!u) return fail('not_found');
    } else {
      [{ id }] = await tx.insert(promotions).values({ tenantId: ctx.tenantId, ...values }).returning({ id: promotions.id });
    }
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'promotion_saved', recordType: 'promotion', recordId: id!, changes: values });
    return { ok: true as const, promotionId: id! };
  });
}

export async function listPromotions(db: Db, ctx: Ctx) {
  assertPermission(ctx, 'manage_promotions');
  return withTenant(db, ctx.tenantId, (tx) => tx.select().from(promotions).orderBy(desc(promotions.createdAt)));
}

export const asPromo = (p: typeof promotions.$inferSelect): Promo => ({ ...p, createdAt: p.createdAt.toISOString() });

const localNow = (timeZone: string, at: Date) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(at);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}`, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')) };
};

/** Automatic promotions running now at the branch (coupon-only promotions are not included). */
export async function activePromotions(tx: Tx, branchId: string, timeZone: string, now: Date): Promise<Promo[]> {
  const at = { ...localNow(timeZone, now), branchId };
  return (await tx.select().from(promotions).where(and(eq(promotions.active, true), eq(promotions.requiresCoupon, false)))).map(asPromo).filter((p) => promoRunning(p, at));
}

export type CouponCheck = { couponId: string; promo: Promo } | 'invalid_coupon';

/** Spec 6.29: active, not expired, uses left, and the customer's own limit not reached. Locks the coupon row for the sale. */
export async function checkCoupon(tx: Tx, code: string, customerId: string | null, branchId: string, timeZone: string, now: Date): Promise<CouponCheck> {
  const [c] = await tx.select().from(coupons).where(eq(coupons.code, code.trim().toUpperCase())).for('update');
  if (!c || !c.active) return 'invalid_coupon';
  const at = { ...localNow(timeZone, now), branchId };
  if (c.expiresOn && at.date > c.expiresOn) return 'invalid_coupon';
  if (c.maxUses !== null && c.usedCount >= c.maxUses) return 'invalid_coupon';
  if (c.perCustomerLimit !== null) {
    if (!customerId) return 'invalid_coupon'; // a per-customer limit needs to know the customer
    const [{ n }] = await tx.select({ n: count() }).from(couponUses).where(and(eq(couponUses.couponId, c.id), eq(couponUses.customerId, customerId)));
    if (n >= c.perCustomerLimit) return 'invalid_coupon';
  }
  const [p] = await tx.select().from(promotions).where(eq(promotions.id, c.promotionId));
  if (!p || !p.active) return 'invalid_coupon';
  const promo = asPromo(p);
  if (!promoRunning(promo, at)) return 'invalid_coupon';
  return { couponId: c.id, promo };
}

/** The coupon is used up when its sale is saved. */
export async function redeemCoupon(tx: Tx, tenantId: string, couponId: string, saleId: string, customerId: string | null): Promise<void> {
  await tx.insert(couponUses).values({ tenantId, couponId, saleId, customerId });
  await tx.update(coupons).set({ usedCount: sql`${coupons.usedCount} + 1` }).where(eq(coupons.id, couponId));
}

export async function saveCoupon(db: Db, ctx: Ctx, input: { code: string; promotionId: string; maxUses?: number | null; perCustomerLimit?: number | null; expiresOn?: string | null }): Promise<
  { ok: true; couponId: string } | Fail<'invalid_input' | 'duplicate_code' | 'not_found'>
> {
  assertPermission(ctx, 'manage_promotions');
  const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
  if (!/^[A-Z0-9-]{3,30}$/.test(code) || !isUuid(input.promotionId) || !int(input.maxUses, 1, 1_000_000) || !int(input.perCustomerLimit, 1, 1000) || (input.expiresOn && !DAY.test(input.expiresOn))) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [p] = await tx.select({ id: promotions.id }).from(promotions).where(eq(promotions.id, input.promotionId));
    if (!p) return fail('not_found');
    const [c] = await tx.insert(coupons).values({ tenantId: ctx.tenantId, code, promotionId: p.id, maxUses: input.maxUses ?? null, perCustomerLimit: input.perCustomerLimit ?? null, expiresOn: input.expiresOn || null })
      .onConflictDoNothing().returning({ id: coupons.id });
    if (!c) return fail('duplicate_code');
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'coupon_created', recordType: 'coupon', recordId: c.id, changes: { code } });
    return { ok: true as const, couponId: c.id };
  });
}

export async function listCoupons(db: Db, ctx: Ctx) {
  assertPermission(ctx, 'manage_promotions');
  return withTenant(db, ctx.tenantId, (tx) => tx.select({ c: coupons, promotionName: promotions.name }).from(coupons).innerJoin(promotions, eq(promotions.id, coupons.promotionId)).orderBy(desc(coupons.createdAt)));
}

/** For the online sell screen: every automatic promotion (it filters by date, time, and branch the same way the device does). */
export async function tillPromotions(db: Db, ctx: Ctx): Promise<Promo[]> {
  assertPermission(ctx, 'make_sale');
  return withTenant(db, ctx.tenantId, async (tx) => (await tx.select().from(promotions).where(and(eq(promotions.active, true), eq(promotions.requiresCoupon, false)))).map(asPromo));
}

/** Checks a coupon for the sell screen without using it up (the sale does that). */
export async function previewCoupon(db: Db, ctx: Ctx, code: string, customerId: string | null, branchId: string, now: Date): Promise<Promo | null> {
  assertPermission(ctx, 'make_sale');
  if (typeof code !== 'string' || !code.trim() || code.length > 30 || !isUuid(branchId) || (customerId && !isUuid(customerId))) return null;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const c = await checkCoupon(tx, code, customerId, branchId, ctx.timezone, now);
    return c === 'invalid_coupon' ? null : c.promo;
  });
}

export async function setPromotionActive(db: Db, ctx: Ctx, id: string, active: boolean): Promise<{ ok: true } | Fail<'not_found'>> {
  assertPermission(ctx, 'manage_promotions');
  if (!isUuid(id)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [p] = await tx.update(promotions).set({ active }).where(eq(promotions.id, id)).returning({ id: promotions.id });
    if (!p) return fail('not_found');
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: active ? 'promotion_started' : 'promotion_stopped', recordType: 'promotion', recordId: id });
    return { ok: true as const };
  });
}
