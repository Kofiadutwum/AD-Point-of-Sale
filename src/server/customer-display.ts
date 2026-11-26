import 'server-only';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { cartSnapshots, customerDisplays, type DisplayCart, displayPairings, promotions, registers, tenants } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { promoRunning } from '@/lib/promotions';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail } from './products';
import { asPromo } from './promotions';

const PAIR_MINUTES = 10;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Spec 6.50: a 6-digit code shown on the till for 10 minutes; a display that enters it is linked to this register only. */
export async function startPairing(db: Db, ctx: Ctx, now: Date): Promise<{ ok: true; code: string; expiresAt: Date } | Fail<'no_register'>> {
  assertPermission(ctx, 'make_sale');
  if (!ctx.registerId) return fail('no_register');
  const registerId = ctx.registerId;
  const expiresAt = new Date(now.getTime() + PAIR_MINUTES * 60_000);
  for (let tries = 0; tries < 5; tries++) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const saved = await asPlatform(db, async (tx) => {
      const [clash] = await tx.select({ code: displayPairings.code }).from(displayPairings).where(and(eq(displayPairings.code, code), gt(displayPairings.expiresAt, now)));
      if (clash) return false;
      await tx.delete(displayPairings).where(eq(displayPairings.code, code)); // an expired one with the same code
      await tx.insert(displayPairings).values({ tenantId: ctx.tenantId, registerId, code, expiresAt })
        .onConflictDoUpdate({ target: [displayPairings.tenantId, displayPairings.registerId], set: { code, expiresAt } });
      return true;
    });
    if (saved) return { ok: true, code, expiresAt };
  }
  throw new Error('could not find a free pairing code');
}

/** The display page enters the code; it gets a token that can read one register's cart and nothing else. */
export async function pairDisplay(db: Db, slug: string, code: string, now: Date): Promise<{ ok: true; token: string } | Fail<'invalid_code'>> {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return fail('invalid_code');
  return asPlatform(db, async (tx) => {
    const [p] = await tx.select({ p: displayPairings, slug: tenants.slug }).from(displayPairings).innerJoin(tenants, eq(tenants.id, displayPairings.tenantId))
      .where(and(eq(displayPairings.code, code.trim()), gt(displayPairings.expiresAt, now)));
    if (!p || p.slug !== slug) return fail('invalid_code');
    const token = randomBytes(24).toString('base64url');
    await tx.insert(customerDisplays).values({ tenantId: p.p.tenantId, registerId: p.p.registerId, tokenHash: hash(token) });
    await tx.delete(displayPairings).where(eq(displayPairings.registerId, p.p.registerId));
    return { ok: true as const, token };
  });
}

/** The till sends its current cart (null when the sale ends) for its paired display. */
export async function pushCart(db: Db, ctx: Ctx, cart: DisplayCart | null, now: Date): Promise<{ ok: true } | Fail<'no_register' | 'invalid_input'>> {
  assertPermission(ctx, 'make_sale');
  if (!ctx.registerId) return fail('no_register');
  if (cart !== null && (typeof cart !== 'object' || !Array.isArray(cart.lines) || cart.lines.length > 200 || ![cart.totalPesewas, cart.discountPesewas, cart.paidPesewas, cart.changePesewas].every((n) => Number.isInteger(n) && n >= 0))) return fail('invalid_input');
  const clean = cart && { ...cart, lines: cart.lines.map((l) => ({ name: String(l.name).slice(0, 80), quantity: String(l.quantity).slice(0, 12), totalPesewas: Math.max(0, Math.round(Number(l.totalPesewas) || 0)) })) };
  const registerId = ctx.registerId;
  await withTenant(db, ctx.tenantId, (tx) => tx.insert(cartSnapshots).values({ tenantId: ctx.tenantId, registerId, cart: clean, updatedAt: now })
    .onConflictDoUpdate({ target: [cartSnapshots.tenantId, cartSnapshots.registerId], set: { cart: clean, updatedAt: now } }));
  return { ok: true };
}

export type DisplayState = { shopName: string; momoNumber: string | null; cart: DisplayCart | null; promotions: string[] };

/** What a paired display shows: the cart, the MoMo number, and between sales the promotions running now. No staff, other carts, or reports. */
export async function displayState(db: Db, slug: string, token: string, now: Date): Promise<DisplayState | null> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  return asPlatform(db, async (tx) => {
    const [d] = await tx.select({ d: customerDisplays, t: tenants, branchId: registers.branchId }).from(customerDisplays)
      .innerJoin(tenants, eq(tenants.id, customerDisplays.tenantId)).innerJoin(registers, eq(registers.id, customerDisplays.registerId))
      .where(eq(customerDisplays.tokenHash, hash(token)));
    if (!d || d.t.slug !== slug || d.t.status !== 'active') return null;
    const [snap] = await tx.select().from(cartSnapshots).where(and(eq(cartSnapshots.tenantId, d.t.id), eq(cartSnapshots.registerId, d.d.registerId)));
    const cart = snap && now.getTime() - snap.updatedAt.getTime() < 30 * 60_000 ? snap.cart : null; // a cart left for half an hour is not shown
    let names: string[] = [];
    if (!cart) {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: d.t.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(now);
      const g = (k: string) => parts.find((x) => x.type === k)?.value ?? '';
      const at = { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}`, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')), branchId: d.branchId };
      names = (await tx.select().from(promotions).where(and(eq(promotions.tenantId, d.t.id), eq(promotions.active, true), eq(promotions.requiresCoupon, false))))
        .map(asPromo).filter((p) => promoRunning(p, at)).map((p) => p.name);
    }
    return { shopName: d.t.name, momoNumber: d.t.momoNumber, cart: cart ?? null, promotions: names };
  });
}
