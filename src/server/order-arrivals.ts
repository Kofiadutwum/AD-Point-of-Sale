import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { customerOrders, customers, stockBalances, tenants } from '@/db/schema';
import { toMilli } from '@/lib/decimal';
import { queue } from './notifications';

/** Spec 6.34: when stock arrives at a branch, open special orders whose items are all there become ready, and the customer gets an SMS. */
export async function markSpecialOrdersReady(tx: Tx, tenantId: string, branchId: string, variantIds: string[], now: Date): Promise<number> {
  if (!variantIds.length) return 0;
  const open = await tx.select().from(customerOrders).where(and(eq(customerOrders.branchId, branchId), eq(customerOrders.kind, 'special'), eq(customerOrders.status, 'open')));
  const touched = open.filter((o) => o.lines.some((l) => variantIds.includes(l.variantId)));
  if (!touched.length) return 0;
  const [shop] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  let ready = 0;
  for (const o of touched) {
    const ids = [...new Set(o.lines.map((l) => l.variantId))];
    const bal = await tx.select().from(stockBalances).where(and(eq(stockBalances.branchId, branchId), inArray(stockBalances.variantId, ids)));
    const enough = ids.every((v) => {
      const need = o.lines.filter((l) => l.variantId === v).reduce((s, l) => s + toMilli(l.baseQuantity), 0n);
      const b = bal.find((x) => x.variantId === v);
      return b !== undefined && toMilli(b.onHand) - toMilli(b.reserved) >= need;
    });
    if (!enough) continue;
    await tx.update(customerOrders).set({ status: 'ready' }).where(eq(customerOrders.id, o.id));
    const [c] = await tx.select({ phone: customers.phone }).from(customers).where(eq(customers.id, o.customerId));
    if (c?.phone) await queue(tx, tenantId, { key: `order-ready:${o.id}`, kind: 'order', toPhone: c.phone, body: `${shop.name}: your order ${o.number} has arrived and is ready to collect.`, sendAfter: now });
    ready++;
  }
  return ready;
}
