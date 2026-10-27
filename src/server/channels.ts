import 'server-only';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { priceLists, salesChannels } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import type { ChannelKind } from '@/lib/food';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { foodEnabled } from './food-settings';
import type { Fail } from './products';

export type Channel = { id: string; name: string; kind: ChannelKind; priceListId: string | null; commissionBp: number; collectedBy: 'app' | 'shop'; active: boolean };

const channelSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(40),
  kind: z.enum(['delivery_app', 'phone', 'whatsapp']),
  priceListId: z.uuid().nullable(),
  commissionBp: z.number().int().min(0).max(10000),
  collectedBy: z.enum(['app', 'shop']),
  active: z.boolean(),
});
const columns = {
  id: salesChannels.id, name: salesChannels.name, kind: salesChannels.kind, priceListId: salesChannels.priceListId,
  commissionBp: salesChannels.commissionBp, collectedBy: salesChannels.collectedBy, active: salesChannels.active,
};

/** The shop's channels, for the till (selling) and the settings page. */
export async function listChannels(db: Db, ctx: Ctx): Promise<Channel[]> {
  if (!ctx.permissions.includes('make_sale')) assertPermission(ctx, 'manage_channels');
  return withTenant(db, ctx.tenantId, (tx) => tx.select(columns).from(salesChannels).orderBy(asc(salesChannels.name)));
}

/** Spec 6.57: adds or edits a channel; phone and WhatsApp are always collected by the shop; channels are made inactive, never deleted. */
export async function saveChannel(
  db: Db, ctx: Ctx, input: Omit<Channel, 'id'> & { id?: string },
): Promise<{ ok: true; channelId: string } | Fail<'invalid_input' | 'duplicate_name' | 'unknown_price_list' | 'module_off'>> {
  assertPermission(ctx, 'manage_channels');
  const parsed = channelSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };
  const c = { ...parsed.data, collectedBy: parsed.data.kind === 'delivery_app' ? parsed.data.collectedBy : 'shop' as const };
  return withTenant(db, ctx.tenantId, async (tx) => {
    if (!(await foodEnabled(tx))) return { ok: false, error: 'module_off' } as const;
    if (c.priceListId) {
      const [list] = await tx.select({ id: priceLists.id }).from(priceLists).where(eq(priceLists.id, c.priceListId));
      if (!list) return { ok: false, error: 'unknown_price_list' } as const;
    }
    const [clash] = await tx.select({ id: salesChannels.id }).from(salesChannels)
      .where(and(sql`lower(${salesChannels.name}) = lower(${c.name})`, c.id ? ne(salesChannels.id, c.id) : sql`true`));
    if (clash) return { ok: false, error: 'duplicate_name' } as const;
    const values = { name: c.name, kind: c.kind, priceListId: c.priceListId, commissionBp: c.commissionBp, collectedBy: c.collectedBy, active: c.active };
    const [row] = c.id
      ? await tx.update(salesChannels).set(values).where(eq(salesChannels.id, c.id)).returning({ id: salesChannels.id })
      : await tx.insert(salesChannels).values({ tenantId: ctx.tenantId, ...values }).returning({ id: salesChannels.id });
    if (!row) return { ok: false, error: 'invalid_input' } as const;
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'channel_saved', recordType: 'channel', recordId: row.id, changes: values });
    return { ok: true, channelId: row.id } as const;
  });
}
