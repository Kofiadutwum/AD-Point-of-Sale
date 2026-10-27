import 'server-only';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { kitchenOrders, type PendingLine, products, registers, salesChannels, tenants, users, variants, variantUnits } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { businessDate } from '@/lib/dates';
import { parseQuantity, validSaleQuantity } from '@/lib/decimal';
import { type DiningOption, phoneCustomer } from '@/lib/food';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, isUuid } from './products';
import { nextOrderNumber, priceCombo } from './sales';
import { isSoldOut } from './sold-out';

const lineSchema = z.object({
  variantId: z.uuid(), unitId: z.uuid(), quantity: z.string().max(20), byAmount: z.boolean().optional(),
  amountPesewas: z.number().int().min(1).max(2_000_000_000).optional(),
  choices: z.array(z.object({ slotId: z.uuid(), variantId: z.uuid() })).max(20).optional(),
});
const inputSchema = z.object({
  channelId: z.uuid(), diningOption: z.enum(['takeaway', 'delivery']),
  customer: z.object({ name: z.string().max(100), phone: z.string().max(30) }),
  pickupAt: z.iso.datetime({ offset: true }).optional(), deliveryAddress: z.string().max(300).optional(),
  lines: z.array(lineSchema).min(1).max(200),
});

export type PhoneOrderInput = z.input<typeof inputSchema>;
type CreateError = 'invalid_input' | 'no_register' | 'unknown_channel' | 'customer_details_required' | 'unknown_item' | 'not_sellable'
  | 'invalid_quantity' | 'invalid_choices' | 'sold_out';
type CreateResult = { ok: true; kitchenOrderId: string; orderNumber: string } | Fail<CreateError>;

/** The till's branch and today's business date, when the signed-in user works there. */
async function tillBranch(tx: Tx, ctx: Ctx, now: Date): Promise<{ branchId: string; day: string } | null> {
  if (!ctx.registerId) return null;
  const [reg] = await tx.select({ branchId: registers.branchId, status: registers.status }).from(registers).where(eq(registers.id, ctx.registerId));
  const [me] = await tx.select({ branchIds: users.branchIds }).from(users).where(eq(users.id, ctx.userId));
  if (!reg || reg.status !== 'active' || !me?.branchIds.includes(reg.branchId)) return null;
  const [shop] = await tx.select({ timezone: tenants.timezone, cutoff: tenants.businessDayCutoff }).from(tenants).where(eq(tenants.id, ctx.tenantId));
  return { branchId: reg.branchId, day: businessDate(shop.timezone, shop.cutoff, now) };
}

/** Spec 6.57: a phone or WhatsApp order sent to the kitchen now and paid when it is collected. Online only. */
export async function createPhoneOrder(db: Db, ctx: Ctx, input: PhoneOrderInput, now: Date): Promise<CreateResult> {
  assertPermission(ctx, 'enter_channel_orders');
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return fail('invalid_input');
  const o = parsed.data;
  return withTenant(db, ctx.tenantId, async (tx): Promise<CreateResult> => {
    const till = await tillBranch(tx, ctx, now);
    if (!till) return fail('no_register');
    const [channel] = await tx.select().from(salesChannels).where(eq(salesChannels.id, o.channelId));
    if (!channel || !channel.active || channel.kind === 'delivery_app') return fail('unknown_channel');
    const who = phoneCustomer(o);
    if (!who) return fail('customer_details_required');

    // the same item checks as a sale, without prices: those are charged at collection
    const lines: PendingLine[] = [];
    for (const l of o.lines) {
      const quantity = parseQuantity(l.quantity);
      const [item] = await tx.select({
        isBase: variantUnits.isBase, unitSellable: variantUnits.sellable, allowsFractions: variants.allowsFractions, sellable: variants.sellable,
        variantStatus: variants.status, productStatus: products.status, kind: variants.kind, sellByAmount: variants.sellByAmount, minAmount: variants.minAmountPesewas,
      }).from(variantUnits).innerJoin(variants, eq(variants.id, variantUnits.variantId)).innerJoin(products, eq(products.id, variants.productId))
        .where(and(eq(variantUnits.id, l.unitId), eq(variantUnits.variantId, l.variantId)));
      if (!item) return fail('unknown_item');
      if (!item.sellable || !item.unitSellable || item.variantStatus === 'archived' || item.productStatus === 'archived') return fail('not_sellable');
      if (!quantity || !validSaleQuantity(quantity, item.isBase && item.allowsFractions)) return fail('invalid_quantity');
      const byAmount = l.byAmount === true;
      if (item.sellByAmount !== byAmount || (byAmount && (quantity !== '1.000' || (l.amountPesewas ?? 0) < (item.minAmount ?? 1)))) return fail('invalid_quantity');
      if (item.kind !== 'combo' && l.choices?.length) return fail('invalid_choices');
      if (item.kind === 'combo') {
        const combo = await priceCombo(tx, l.variantId, l.choices ?? [], till.branchId, till.day);
        if (combo === 'sold_out') return fail('sold_out');
        if (typeof combo !== 'object') return fail('invalid_choices');
      }
      lines.push({
        variantId: l.variantId, unitId: l.unitId, quantity,
        ...(byAmount ? { byAmount: true, amountPesewas: l.amountPesewas } : {}), ...(l.choices?.length ? { choices: l.choices } : {}),
      });
    }
    if ((await isSoldOut(tx, till.branchId, [...new Set(lines.map((l) => l.variantId))], till.day)).size) return fail('sold_out');

    const orderNumber = await nextOrderNumber(tx, ctx.tenantId, till.branchId, till.day);
    const [row] = await tx.insert(kitchenOrders).values({
      tenantId: ctx.tenantId, branchId: till.branchId, orderNumber, businessDate: till.day, diningOption: o.diningOption, needsPacking: true, sentAt: now,
      channelId: channel.id, customerName: who.name, customerPhone: who.phone, pickupAt: who.pickupAt, deliveryAddress: who.deliveryAddress,
      payOnCollect: true, pendingLines: lines,
    }).returning({ id: kitchenOrders.id });
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'phone_order_created', recordType: 'kitchen_order', recordId: row.id,
      changes: { orderNumber, channelId: channel.id },
    });
    return { ok: true, kitchenOrderId: row.id, orderNumber };
  });
}

/** Today's unpaid phone order with this number at the till's branch, for collection. */
export async function findPhoneOrder(db: Db, ctx: Ctx, orderNumber: string, now: Date): Promise<{
  kitchenOrderId: string; channelId: string; diningOption: DiningOption; customerName: string; lines: PendingLine[];
} | null> {
  assertPermission(ctx, 'enter_channel_orders');
  if (typeof orderNumber !== 'string' || orderNumber.length > 10) return null;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const till = await tillBranch(tx, ctx, now);
    if (!till) return null;
    const [o] = await tx.select().from(kitchenOrders).where(and(
      eq(kitchenOrders.branchId, till.branchId), eq(kitchenOrders.businessDate, till.day), eq(kitchenOrders.orderNumber, orderNumber.trim()),
      eq(kitchenOrders.payOnCollect, true), isNull(kitchenOrders.saleId), inArray(kitchenOrders.status, ['preparing', 'ready']),
    ));
    return o ? { kitchenOrderId: o.id, channelId: o.channelId!, diningOption: o.diningOption, customerName: o.customerName!, lines: o.pendingLines! } : null;
  });
}

/** Staff cancel a phone order that was never paid for, with a reason (spec 6.57). */
export async function cancelPhoneOrder(
  db: Db, ctx: Ctx, input: { kitchenOrderId: string; reason: string }, now: Date,
): Promise<{ ok: true } | Fail<'not_found' | 'already_paid' | 'invalid_input'>> {
  assertPermission(ctx, 'enter_channel_orders');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 1 || reason.length > 200) return fail('invalid_input');
  if (!isUuid(input.kitchenOrderId)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx): Promise<{ ok: true } | Fail<'not_found' | 'already_paid'>> => {
    const [order] = await tx.select().from(kitchenOrders).where(eq(kitchenOrders.id, input.kitchenOrderId)).for('update');
    const [me] = await tx.select({ branchIds: users.branchIds }).from(users).where(eq(users.id, ctx.userId));
    if (!order || !me?.branchIds.includes(order.branchId)) return fail('not_found');
    if (order.saleId) return fail('already_paid');
    if (!order.payOnCollect || !['preparing', 'ready'].includes(order.status)) return fail('not_found');
    await tx.update(kitchenOrders).set({ status: 'cancelled', closedAt: now, closedBy: ctx.userId }).where(eq(kitchenOrders.id, order.id));
    await writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'phone_order_cancelled', recordType: 'kitchen_order', recordId: order.id, changes: { reason },
    });
    return { ok: true };
  });
}
