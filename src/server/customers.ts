import 'server-only';
import { and, asc, eq, gte, ilike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { customers, priceLists, storeCreditEntries } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { normaliseGhanaPhone } from '@/lib/contact';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, isUuid } from './products';

export type Customer = { id: string; name: string; phone: string; priceListId: string | null; storeCreditPesewas: number };

const columns = {
  id: customers.id, name: customers.name, phone: customers.phone, priceListId: customers.priceListId, storeCreditPesewas: customers.storeCreditPesewas,
};
const amount = z.number().int().min(1).max(2_000_000_000);

/** Cashiers add customers at the till; store credit needs a name and phone (spec 6.31). */
export async function addCustomer(
  db: Db, ctx: Ctx, input: { name: string; phone: string; priceListId?: string | null },
): Promise<{ ok: true; customerId: string } | Fail<'invalid_input' | 'duplicate_phone' | 'unknown_price_list'>> {
  assertPermission(ctx, 'make_sale');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const phone = typeof input.phone === 'string' ? normaliseGhanaPhone(input.phone) : null;
  const priceListId = input.priceListId || null;
  if (!name || name.length > 80 || !phone) return fail('invalid_input');
  return withTenant(db, ctx.tenantId, async (tx) => {
    if (priceListId) {
      const [l] = isUuid(priceListId) ? await tx.select({ id: priceLists.id }).from(priceLists).where(eq(priceLists.id, priceListId)) : [];
      if (!l) return fail('unknown_price_list');
    }
    const [row] = await tx.insert(customers).values({ tenantId: ctx.tenantId, name, phone, priceListId })
      .onConflictDoNothing({ target: [customers.tenantId, customers.phone] }).returning({ id: customers.id });
    if (!row) return fail('duplicate_phone');
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'customer_added', recordType: 'customer', recordId: row.id });
    return { ok: true, customerId: row.id } as const;
  });
}

/** Readable by any signed-in member: the till looks customers up by name or phone. */
export async function listCustomers(db: Db, ctx: Ctx, opts: { query?: string; limit?: number }): Promise<Customer[]> {
  const query = opts.query?.trim() ?? '';
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const phone = query ? normaliseGhanaPhone(query) : null;
  const pattern = `%${query.replace(/[\%_]/g, '\$&')}%`;
  return withTenant(db, ctx.tenantId, (tx) => tx.select(columns).from(customers)
    .where(query ? or(ilike(customers.name, pattern), phone ? eq(customers.phone, phone) : ilike(customers.phone, pattern)) : undefined)
    .orderBy(sql`lower(${customers.name})`, asc(customers.id)).limit(limit));
}

/** Adds to a customer's store credit with a ledger entry; the new balance, or null for an unknown customer. Used by returns (Phase 1b). */
export async function creditStoreCredit(
  tx: Tx, e: { tenantId: string; customerId: string; amountPesewas: number; source: 'refund' | 'goodwill'; userId: string; saleId?: string; reason?: string },
): Promise<number | null> {
  const [row] = await tx.update(customers).set({ storeCreditPesewas: sql`${customers.storeCreditPesewas} + ${e.amountPesewas}` })
    .where(eq(customers.id, e.customerId)).returning({ balance: customers.storeCreditPesewas });
  if (!row) return null;
  await tx.insert(storeCreditEntries).values({
    tenantId: e.tenantId, customerId: e.customerId, type: 'issued', source: e.source, amountPesewas: e.amountPesewas,
    saleId: e.saleId ?? null, reason: e.reason ?? null, userId: e.userId,
  });
  return row.balance;
}

/** Spends store credit inside a sale's transaction; false when the balance is too low. One statement, so two sales can never overdraw it. */
export async function redeemStoreCredit(
  tx: Tx, e: { tenantId: string; customerId: string; amountPesewas: number; saleId: string; userId: string },
): Promise<boolean> {
  const [row] = await tx.update(customers).set({ storeCreditPesewas: sql`${customers.storeCreditPesewas} - ${e.amountPesewas}` })
    .where(and(eq(customers.id, e.customerId), gte(customers.storeCreditPesewas, e.amountPesewas))).returning({ id: customers.id });
  if (!row) return false;
  await tx.insert(storeCreditEntries).values({
    tenantId: e.tenantId, customerId: e.customerId, type: 'redeemed', source: 'sale', amountPesewas: -e.amountPesewas, saleId: e.saleId, userId: e.userId,
  });
  return true;
}

/** Spec 6.31: goodwill credit needs approval; until approvals arrive (6.7) only holders of approve_actions may give it. */
export async function issueStoreCredit(
  db: Db, ctx: Ctx, input: { customerId: string; amountPesewas: number; source: 'refund' | 'goodwill'; reason: string }, _now: Date,
): Promise<{ ok: true; balancePesewas: number } | Fail<'invalid_input' | 'not_found'>> {
  assertPermission(ctx, 'approve_actions');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!amount.safeParse(input.amountPesewas).success || !['refund', 'goodwill'].includes(input.source) || !reason || reason.length > 200) {
    return fail('invalid_input');
  }
  if (!isUuid(input.customerId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const balance = await creditStoreCredit(tx, { tenantId: ctx.tenantId, customerId: input.customerId, amountPesewas: input.amountPesewas, source: input.source, userId: ctx.userId, reason });
    if (balance === null) return fail('not_found');
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'store_credit_issued', recordType: 'customer', recordId: input.customerId,
      reason, changes: { amountPesewas: input.amountPesewas, source: input.source },
    });
    return { ok: true, balancePesewas: balance } as const;
  });
}
