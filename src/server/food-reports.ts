import 'server-only';
import { and, asc, between, count, eq, inArray, ne, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { components, kitchenOrders, potRecords, products, saleLines, sales, salesChannels, tenants, variants, wastageEntries } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { toCsv } from '@/lib/csv';
import { fromMilli, multiplyQty, toMilli } from '@/lib/decimal';
import { splitComboNet } from '@/lib/food';
import { pesewasTimesQty } from '@/lib/money';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, itemLabel } from './products';

export type FoodReportInput = { from: string; to: string; branchId?: string; serviceMode?: 'counter' | 'quick' };
type Item = { variantId: string; name: string; quantity: string; valuePesewas: number };
export type FoodReport = {
  byHour: Array<{ hour: number; orders: number; valuePesewas: number }>;
  items: Item[]; best: Item[]; slowest: Item[];
  channels: Array<{ channelId: string | null; name: string; orders: number; salesPesewas: number; commissionPesewas: number; afterCommissionPesewas: number }>;
  wastage: Array<{ reason: string; entries: number; costPesewas: number }>;
  pots: Array<{ businessDate: string; name: string; expectedPesewas: number | null; actualPesewas: number | null; variancePesewas: number | null; flagged: boolean }>;
  avgKitchenSeconds: number | null;
  avgCounterWaitSeconds: number | null;
};
type ReportResult = { ok: true; report: FoodReport } | Fail<'invalid_input' | 'range_too_long'>;

const MAX_DAYS = 92;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)));
const inputSchema = z.object({ from: day, to: day, branchId: z.uuid().optional(), serviceMode: z.enum(['counter', 'quick']).optional() });
const num = (v: unknown) => Number(v ?? 0);

/** Spec 6.59: completed sales only, by business date; a sale's hour is the earlier of the device and server clocks, in the shop's timezone. */
export async function foodReport(db: Db, ctx: Ctx, input: FoodReportInput, now: Date): Promise<ReportResult> {
  assertPermission(ctx, 'view_reports');
  return build(db, ctx, input, now);
}

/** The report as CSV, one titled section per block; text cells that could run as formulas are neutralised by toCsv. */
export async function foodReportCsv(db: Db, ctx: Ctx, input: FoodReportInput, now: Date): Promise<{ ok: true; csv: string } | Fail<'invalid_input' | 'range_too_long'>> {
  assertPermission(ctx, 'export_data');
  const r = await build(db, ctx, input, now);
  if (!r.ok) return r;
  const rep = r.report;
  const rows: Array<Array<string | number | null>> = [
    ['Orders by hour'], ['Hour', 'Orders', 'Value (pesewas)'], ...rep.byHour.map((h) => [h.hour, h.orders, h.valuePesewas]), [],
    ['Item sales'], ['Item', 'Quantity', 'Value (pesewas)'], ...rep.items.map((i) => [i.name, i.quantity, i.valuePesewas]), [],
    ['Slowest items'], ['Item', 'Quantity', 'Value (pesewas)'], ...rep.slowest.map((i) => [i.name, i.quantity, i.valuePesewas]), [],
    ['Channels'], ['Channel', 'Orders', 'Sales (pesewas)', 'Commission (pesewas)', 'After commission (pesewas)'],
    ...rep.channels.map((c) => [c.name, c.orders, c.salesPesewas, c.commissionPesewas, c.afterCommissionPesewas]), [],
    ['Wastage'], ['Reason', 'Entries', 'Cost (pesewas)'], ...rep.wastage.map((w) => [w.reason, w.entries, w.costPesewas]), [],
    ['Pots'], ['Date', 'Item', 'Expected (pesewas)', 'Actual (pesewas)', 'Variance (pesewas)', 'Flagged'],
    ...rep.pots.map((p) => [p.businessDate, p.name, p.expectedPesewas, p.actualPesewas, p.variancePesewas, p.flagged ? 'yes' : 'no']), [],
    ['Kitchen'], ['Average kitchen seconds', 'Average counter wait seconds'], [rep.avgKitchenSeconds, rep.avgCounterWaitSeconds],
  ];
  return { ok: true, csv: toCsv(rows) };
}

async function build(db: Db, ctx: Ctx, input: FoodReportInput, _now: Date): Promise<ReportResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || parsed.data.to < parsed.data.from) return fail('invalid_input');
  const f = parsed.data;
  if ((Date.parse(f.to) - Date.parse(f.from)) / 86_400_000 + 1 > MAX_DAYS) return fail('range_too_long');
  return withTenant(db, ctx.tenantId, async (tx): Promise<ReportResult> => {
    const [shop] = await tx.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const where = and(
      eq(sales.status, 'completed'), between(sales.businessDate, f.from, f.to),
      f.branchId ? eq(sales.branchId, f.branchId) : undefined, f.serviceMode ? eq(sales.serviceMode, f.serviceMode) : undefined,
    );

    const hour = sql<number>`extract(hour from (least(${sales.deviceCreatedAt}, ${sales.receivedAt}) at time zone ${shop.timezone}))::int`;
    const hours = await tx.select({ hour, orders: count(), value: sql<string>`sum(${sales.totalPesewas})` }).from(sales).where(where).groupBy(sql`1`);
    const byHour = Array.from({ length: 24 }, (_, h) => {
      const row = hours.find((r) => num(r.hour) === h);
      return { hour: h, orders: num(row?.orders), valuePesewas: num(row?.value) };
    });

    const channelRows = await tx.select({
      channelId: sales.channelId, name: salesChannels.name, orders: count(),
      total: sql<string>`sum(${sales.totalPesewas})`, commission: sql<string>`sum(${sales.commissionPesewas})`,
    }).from(sales).leftJoin(salesChannels, eq(salesChannels.id, sales.channelId)).where(where).groupBy(sales.channelId, salesChannels.name);
    const channels = channelRows.map((c) => ({
      channelId: c.channelId, name: c.name ?? 'Walk-in', orders: num(c.orders), salesPesewas: num(c.total), commissionPesewas: num(c.commission),
      afterCommissionPesewas: num(c.total) - num(c.commission),
    })).sort((a, b) => (a.channelId === null ? -1 : b.channelId === null ? 1 : a.name.localeCompare(b.name)));

    const items = await itemSales(tx, where);
    const sold = [...items.values()].sort((a, b) => b.valuePesewas - a.valuePesewas || a.name.localeCompare(b.name));
    const unsold = (await tx.select({ id: variants.id, productName: products.name, variantName: variants.name }).from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(and(eq(variants.sellable, true), eq(variants.status, 'active'), eq(products.status, 'active'), ne(variants.kind, 'combo'))))
      .filter((v) => !items.has(v.id)).map((v) => ({ variantId: v.id, name: itemLabel(v.productName, v.variantName), quantity: '0.000', valuePesewas: 0 }));
    const slowest = [...sold, ...unsold].sort((a, b) => Number(toMilli(a.quantity) - toMilli(b.quantity)) || a.name.localeCompare(b.name)).slice(0, 10);

    const placeDates = (table: typeof wastageEntries | typeof potRecords) => and(
      between(table.businessDate, f.from, f.to), f.branchId ? eq(table.branchId, f.branchId) : undefined,
    );
    const wastage = (await tx.select({ reason: wastageEntries.reason, entries: count(), cost: sql<string>`sum(${wastageEntries.costPesewas})` })
      .from(wastageEntries).where(placeDates(wastageEntries)).groupBy(wastageEntries.reason).orderBy(asc(wastageEntries.reason)))
      .map((w) => ({ reason: w.reason, entries: num(w.entries), costPesewas: num(w.cost) }));
    const pots = (await tx.select({
      businessDate: potRecords.businessDate, productName: products.name, variantName: variants.name, expected: potRecords.expectedPesewas,
      actual: potRecords.actualPesewas, variance: potRecords.variancePesewas, flagged: potRecords.flagged,
    }).from(potRecords).innerJoin(variants, eq(variants.id, potRecords.variantId)).innerJoin(products, eq(products.id, variants.productId))
      .where(placeDates(potRecords)).orderBy(asc(potRecords.businessDate), asc(products.name)))
      .map((p) => ({ businessDate: p.businessDate, name: itemLabel(p.productName, p.variantName), expectedPesewas: p.expected, actualPesewas: p.actual, variancePesewas: p.variance, flagged: p.flagged }));

    const [times] = await tx.select({
      kitchen: sql<string | null>`avg(extract(epoch from ${kitchenOrders.readyAt} - ${kitchenOrders.sentAt}))`,
      wait: sql<string | null>`avg(extract(epoch from ${kitchenOrders.closedAt} - ${kitchenOrders.sentAt})) filter (where ${kitchenOrders.status} in ('collected', 'handed_over'))`,
    }).from(kitchenOrders).innerJoin(sales, eq(sales.id, kitchenOrders.saleId)).where(where);
    const seconds = (v: string | null | undefined) => (v === null || v === undefined ? null : Math.round(Number(v)));

    return { ok: true, report: {
      byHour, items: sold, best: sold.slice(0, 10), slowest, channels, wastage, pots,
      avgKitchenSeconds: seconds(times?.kitchen), avgCounterWaitSeconds: seconds(times?.wait),
    } };
  });
}

/** Value of a line = gross − discount; a combo's value is split over its fixed items and choices by their current prices. */
async function itemSales(tx: Tx, where: SQL | undefined): Promise<Map<string, Item>> {
  const lines = await tx.select({
    variantId: saleLines.variantId, name: saleLines.name, quantity: saleLines.quantity, gross: saleLines.grossPesewas, discount: saleLines.discountPesewas,
    choices: saleLines.choices, kind: variants.kind,
  }).from(saleLines).innerJoin(sales, eq(sales.id, saleLines.saleId)).innerJoin(variants, eq(variants.id, saleLines.variantId)).where(where);
  const comboIds = [...new Set(lines.filter((l) => l.kind === 'combo').map((l) => l.variantId))];
  const fixed = comboIds.length ? await tx.select().from(components).where(inArray(components.parentVariantId, comboIds)) : [];
  const partIds = [...new Set([...fixed.map((c) => c.componentVariantId), ...lines.flatMap((l) => (l.choices ?? []).map((c) => c.variantId))])];
  const catalogue = partIds.length ? await tx.select({ id: variants.id, price: variants.basePricePesewas, productName: products.name, variantName: variants.name })
    .from(variants).innerJoin(products, eq(products.id, variants.productId)).where(inArray(variants.id, partIds)) : [];

  const totals = new Map<string, { name: string; milli: bigint; value: number }>();
  const add = (variantId: string, name: string, quantity: string, value: number) => {
    const row = totals.get(variantId) ?? { name, milli: 0n, value: 0 };
    row.milli += toMilli(quantity);
    row.value += value;
    totals.set(variantId, row);
  };
  for (const l of lines) {
    const net = l.gross - l.discount;
    const parts = l.kind !== 'combo' ? [] : [
      ...fixed.filter((c) => c.parentVariantId === l.variantId).map((c) => ({ variantId: c.componentVariantId, quantity: multiplyQty(c.quantity, l.quantity) })),
      ...(l.choices ?? []).map((c) => ({ variantId: c.variantId, quantity: l.quantity })),
    ];
    if (!parts.length) {
      add(l.variantId, l.name, l.quantity, net);
      continue;
    }
    const known = (id: string) => catalogue.find((v) => v.id === id);
    const shares = splitComboNet(net, parts.map((p, i) => ({ key: String(i), weightPesewas: pesewasTimesQty(known(p.variantId)?.price ?? 0, p.quantity) })));
    parts.forEach((p, i) => {
      const v = known(p.variantId);
      add(p.variantId, v ? itemLabel(v.productName, v.variantName) : 'Item', p.quantity, shares.get(String(i)) ?? 0);
    });
  }
  return new Map([...totals].map(([variantId, t]) => [variantId, { variantId, name: t.name, quantity: fromMilli(t.milli), valuePesewas: t.value }]));
}
