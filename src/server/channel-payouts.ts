import 'server-only';
import { and, asc, between, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { channelPayouts, channelReceivables, sales, salesChannels } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, isUuid } from './products';

export type OpenReceivable = { saleId: string; receiptNumber: string; externalOrderId: string; businessDate: string; expectedPesewas: number };

/** Spec 6.57: what an app still owes for the orders it collected, oldest first. */
export async function listOpenReceivables(db: Db, ctx: Ctx, channelId: string): Promise<OpenReceivable[]> {
  assertPermission(ctx, 'manage_channels');
  if (!isUuid(channelId)) return [];
  return withTenant(db, ctx.tenantId, async (tx) => {
    const rows = await tx.select({
      saleId: sales.id, receiptNumber: sales.receiptNumber, externalOrderId: sales.externalOrderId, businessDate: sales.businessDate,
      expectedPesewas: channelReceivables.expectedPesewas,
    }).from(channelReceivables).innerJoin(sales, eq(sales.id, channelReceivables.saleId))
      .where(and(eq(channelReceivables.channelId, channelId), isNull(channelReceivables.payoutId)))
      .orderBy(asc(sales.businessDate), asc(sales.receiptNumber));
    return rows.map((r) => ({ ...r, externalOrderId: r.externalOrderId ?? '' }));
  });
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)));
const payoutSchema = z.object({
  channelId: z.uuid(), amountPesewas: z.number().int().min(1).max(2_000_000_000), reference: z.string().trim().min(1).max(100), periodFrom: day, periodTo: day,
}).refine((p) => p.periodTo >= p.periodFrom);

type PayoutResult = { ok: true; matched: number; expectedPesewas: number; differencePesewas: number }
  | Fail<'invalid_input' | 'unknown_channel' | 'duplicate_reference' | 'nothing_to_match'>;

/** Matches a payout to every open receivable of the channel whose sale's business date is in the period; difference = paid − expected. */
export async function recordChannelPayout(
  db: Db, ctx: Ctx, input: { channelId: string; amountPesewas: number; reference: string; periodFrom: string; periodTo: string }, now: Date,
): Promise<PayoutResult> {
  assertPermission(ctx, 'manage_channels');
  const parsed = payoutSchema.safeParse(input);
  if (!parsed.success) return fail('invalid_input');
  const p = parsed.data;
  return withTenant(db, ctx.tenantId, async (tx): Promise<PayoutResult> => {
    const [channel] = await tx.select({ id: salesChannels.id }).from(salesChannels).where(eq(salesChannels.id, p.channelId));
    if (!channel) return fail('unknown_channel');
    const [reused] = await tx.select({ id: channelPayouts.id }).from(channelPayouts)
      .where(and(eq(channelPayouts.channelId, channel.id), eq(channelPayouts.reference, p.reference)));
    if (reused) return fail('duplicate_reference');
    // locked so two payouts recorded at once cannot claim the same orders
    const open = await tx.select({ id: channelReceivables.id, expected: channelReceivables.expectedPesewas }).from(channelReceivables)
      .innerJoin(sales, eq(sales.id, channelReceivables.saleId))
      .where(and(eq(channelReceivables.channelId, channel.id), isNull(channelReceivables.payoutId), between(sales.businessDate, p.periodFrom, p.periodTo)))
      .for('update', { of: channelReceivables });
    if (!open.length) return fail('nothing_to_match');
    const expected = open.reduce((sum, r) => sum + r.expected, 0);
    const difference = p.amountPesewas - expected;
    const [row] = await tx.insert(channelPayouts).values({
      tenantId: ctx.tenantId, channelId: channel.id, amountPesewas: p.amountPesewas, reference: p.reference, periodFrom: p.periodFrom, periodTo: p.periodTo,
      expectedPesewas: expected, differencePesewas: difference, recordedBy: ctx.userId, createdAt: now,
    }).onConflictDoNothing().returning({ id: channelPayouts.id });
    if (!row) return fail('duplicate_reference'); // another payout with this reference was saved first
    await tx.update(channelReceivables).set({ payoutId: row.id }).where(inArray(channelReceivables.id, open.map((r) => r.id)));
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'channel_payout_recorded', recordType: 'channel_payout', recordId: row.id,
      changes: { channelId: channel.id, amountPesewas: p.amountPesewas, expectedPesewas: expected, matched: open.length },
    });
    return { ok: true, matched: open.length, expectedPesewas: expected, differencePesewas: difference };
  });
}
