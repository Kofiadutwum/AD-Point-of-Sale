import 'server-only';
import { asc, eq, type SQL } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { branches, customers, payments, sales, saleLines, type TenderMethod, tenants, users } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { writeAudit } from './audit';
import type { Ctx } from './context';
import { isUuid } from './products';

export type ReceiptView = {
  shopName: string; branchName: string; branchAddress: string | null; branchPhone: string | null; taxNumber: string | null; footer: string | null;
  receiptNumber: string; createdAt: Date; timezone: string; cashierName: string; customerName: string | null; customerPhone: string | null;
  status: 'pending' | 'completed'; taxMode: 'inclusive' | 'exclusive';
  lines: Array<{ name: string; unitName: string; quantity: string; unitPricePesewas: number; discountPesewas: number; taxPesewas: number; totalPesewas: number; serials: string[]; addOns: string[]; note: string | null }>;
  subtotalPesewas: number; discountPesewas: number; taxPesewas: number; totalPesewas: number;
  payments: Array<{ method: TenderMethod; amountPesewas: number; reference: string | null }>; changeDuePesewas: number; shareCode: string;
};

export const TENDER_LABELS: Record<TenderMethod, string> = {
  cash: 'Cash', momo_manual: 'Mobile money', card_terminal: 'Card', bank_transfer: 'Bank transfer', store_credit: 'Store credit', channel_settlement: 'Paid through delivery app',
};

async function loadReceipt(tx: Tx, where: SQL): Promise<(ReceiptView & { id: string }) | null> {
  const [row] = await tx.select({
    sale: sales, shopName: tenants.name, taxNumber: tenants.taxNumber, footer: tenants.receiptFooter, timezone: tenants.timezone,
    branchName: branches.name, branchAddress: branches.address, branchPhone: branches.phone, cashierName: users.name,
    customerName: customers.name, customerPhone: customers.phone,
  }).from(sales)
    .innerJoin(tenants, eq(tenants.id, sales.tenantId))
    .innerJoin(branches, eq(branches.id, sales.branchId))
    .innerJoin(users, eq(users.id, sales.cashierId))
    .leftJoin(customers, eq(customers.id, sales.customerId))
    .where(where);
  if (!row) return null;
  const s = row.sale;
  const lines = await tx.select().from(saleLines).where(eq(saleLines.saleId, s.id)).orderBy(asc(saleLines.lineNo));
  const paid = await tx.select({ method: payments.method, amountPesewas: payments.amountPesewas, reference: payments.reference }).from(payments)
    .where(eq(payments.saleId, s.id)).orderBy(asc(payments.createdAt));
  return {
    id: s.id, shopName: row.shopName, branchName: row.branchName, branchAddress: row.branchAddress, branchPhone: row.branchPhone,
    taxNumber: row.taxNumber, footer: row.footer, receiptNumber: s.receiptNumber, createdAt: s.deviceCreatedAt, timezone: row.timezone,
    cashierName: row.cashierName, customerName: row.customerName, customerPhone: row.customerPhone, status: s.status, taxMode: s.taxMode,
    lines: lines.map((l) => ({
      name: l.name, unitName: l.unitName, quantity: l.quantity, unitPricePesewas: l.unitPricePesewas, discountPesewas: l.discountPesewas,
      taxPesewas: l.taxPesewas, totalPesewas: l.totalPesewas, serials: l.serials, addOns: l.addOns.map((a) => a.name), note: l.note,
    })),
    subtotalPesewas: s.subtotalPesewas, discountPesewas: s.discountPesewas, taxPesewas: s.taxPesewas, totalPesewas: s.totalPesewas,
    payments: paid, changeDuePesewas: s.changeDuePesewas, shareCode: s.shareCode,
  };
}

/** Any signed-in member of the shop; a reprint is logged (spec 4.10). */
export async function getReceipt(db: Db, ctx: Ctx, saleId: string, opts: { reprint: boolean }): Promise<ReceiptView | null> {
  if (!isUuid(saleId)) return null;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const r = await loadReceipt(tx, eq(sales.id, saleId));
    if (!r) return null;
    if (opts.reprint) {
      await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'receipt_reprinted', recordType: 'sale', recordId: saleId });
    }
    const { id: _id, ...view } = r;
    return view;
  });
}

/** The link a customer opens from WhatsApp: no sign-in, so payment references and customer details are left out. */
export async function getPublicReceipt(db: Db, slug: string, code: string): Promise<ReceiptView | null> {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(code)) return null;
  // pre-sign-in lookup: the slug gives the shop, and the shop's own rows are then read under row-level security
  const [shop] = await asPlatform(db, (tx) => tx.select({ id: tenants.id, status: tenants.status }).from(tenants).where(eq(tenants.slug, slug)));
  if (!shop || shop.status !== 'active') return null;
  const r = await withTenant(db, shop.id, (tx) => loadReceipt(tx, eq(sales.shareCode, code)));
  if (!r) return null;
  const { id: _id, ...view } = r;
  return { ...view, customerName: null, customerPhone: null, payments: view.payments.map((p) => ({ ...p, reference: null })) };
}
