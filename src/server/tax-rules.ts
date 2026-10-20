import 'server-only';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { products, taxRules } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import type { TaxRates } from '@/lib/tax';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { lockTenant } from './plan-limits';

export type TaxRule = typeof taxRules.$inferSelect;
export type TaxRuleInput = TaxRates & { name: string; isDefault: boolean; active: boolean };

const basisPoints = z.number().int().min(0).max(10000);
const ruleSchema = z.object({
  name: z.string().trim().min(1).max(60),
  rateBp: basisPoints,
  levies: z.array(z.object({ name: z.string().trim().min(1).max(40), rateBp: basisPoints })).max(5),
  vatOnLevies: z.boolean(),
  isDefault: z.boolean(),
  active: z.boolean(),
}).refine((r) => r.active || !r.isDefault); // an inactive rule cannot be the default

/** Readable by any signed-in member: the till needs the rules to work out tax. */
export async function listTaxRules(db: Db, ctx: Ctx): Promise<TaxRule[]> {
  return withTenant(db, ctx.tenantId, (tx) => tx.select().from(taxRules).orderBy(asc(taxRules.name)));
}

export async function saveTaxRule(
  db: Db, ctx: Ctx, input: TaxRuleInput & { id?: string },
): Promise<{ ok: true; taxRuleId: string } | { ok: false; error: 'invalid_input' | 'not_found' | 'duplicate_name' | 'in_use' }> {
  assertPermission(ctx, 'manage_shop_settings');
  const parsed = ruleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };
  if (input.id !== undefined && !z.uuid().safeParse(input.id).success) return { ok: false, error: 'not_found' };
  const rule = parsed.data;
  const id = input.id;

  return withTenant(db, ctx.tenantId, async (tx) => {
    await lockTenant(tx, ctx.tenantId);
    if (id) {
      const [existing] = await tx.select({ id: taxRules.id }).from(taxRules).where(eq(taxRules.id, id));
      if (!existing) return { ok: false, error: 'not_found' } as const;
      if (!rule.active) {
        const [used] = await tx.select({ id: products.id }).from(products).where(eq(products.taxRuleId, id)).limit(1);
        if (used) return { ok: false, error: 'in_use' } as const;
      }
    }
    const [dup] = await tx.select({ id: taxRules.id }).from(taxRules).where(and(
      eq(taxRules.tenantId, ctx.tenantId), sql`lower(${taxRules.name}) = lower(${rule.name})`, id ? ne(taxRules.id, id) : undefined,
    ));
    if (dup) return { ok: false, error: 'duplicate_name' } as const;
    if (rule.isDefault) {
      await tx.update(taxRules).set({ isDefault: false })
        .where(and(eq(taxRules.tenantId, ctx.tenantId), eq(taxRules.isDefault, true), id ? ne(taxRules.id, id) : undefined));
    }
    const [saved] = id
      ? await tx.update(taxRules).set(rule).where(eq(taxRules.id, id)).returning({ id: taxRules.id })
      : await tx.insert(taxRules).values({ tenantId: ctx.tenantId, ...rule }).returning({ id: taxRules.id });
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'tax_rule_saved', recordType: 'tax_rule', recordId: saved.id,
      changes: { ...rule },
    });
    return { ok: true, taxRuleId: saved.id } as const;
  });
}
