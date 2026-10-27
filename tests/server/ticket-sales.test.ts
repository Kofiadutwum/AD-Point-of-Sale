import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { diningTables, saleLines, sales, ticketLines, tickets, variants } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { setServiceModes } from '@/server/food-settings';
import { getReceipt } from '@/server/receipts';
import { completeSale, type SaleResult } from '@/server/sales';
import { saveServiceCharge, saveTable } from '@/server/tables';
import { addTicketLine, openTicket, payTicket, printBill, quoteTicket, sendToKitchen, voidSentLine } from '@/server/tickets';
import { ctxFor, foodShop, productFor, type SeededShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t = new Date('2026-10-27T12:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let till: Ctx;
let table1: string;
let ticketId: string;
let jollof: { variantId: string; baseUnitId: string };
let coke: { variantId: string; baseUnitId: string };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await foodShop(db, t, { users: [
    { key: 'owner', email: 'o@x.test', rolePreset: 'owner', pin: '9999' }, { key: 'manager', email: 'm@x.test', rolePreset: 'manager', pin: '1234' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t);
  await setServiceModes(db, owner, shop.branchId, ['counter', 'table']);
  await saveServiceCharge(db, owner, 1000);
  table1 = (await saveTable(db, owner, { branchId: shop.branchId, name: 'Table 1', active: true }) as { tableId: string }).tableId;
  jollof = await productFor(db, owner, { name: 'Jollof', variants: [{ basePricePesewas: 4500, costPesewas: 2000 }] });
  coke = await productFor(db, owner, { name: 'Coke' }); // GHS 5
  till = await tillCtxFor(db, shop, 'owner', t);
  ticketId = (await openTicket(db, till, { tableId: table1, diningOption: 'eat_in' }, t) as { ticketId: string }).ticketId;
  await addTicketLine(db, till, ticketId, { variantId: jollof.variantId, unitId: jollof.baseUnitId, quantity: '2' }, t);
});
afterEach(async () => { await close(); });

const cash = (amount: number) => [{ id: randomUUID(), method: 'cash' as const, amountPesewas: amount }];
const saleOf = async (r: SaleResult) => (await asPlatform(db, (tx) => tx.select().from(sales).where(eq(sales.id, (r as { saleId: string }).saleId))))[0];

it('adds the service charge to the bill', async () => {
  const r = await payTicket(db, till, { ticketId, tenders: cash(9900) }, t);
  expect(r).toMatchObject({ ok: true, status: 'completed', changeDuePesewas: 0 });
  // GHS 90 of jollof + 10% service charge
  expect(await saleOf(r)).toMatchObject({ totalPesewas: 9900, serviceChargePesewas: 900, serviceMode: 'table', diningOption: 'eat_in' });
  expect(await payTicket(db, till, { ticketId, tenders: cash(9000) }, t)).toEqual({ ok: false, error: 'ticket_not_open' });
});

it('the bill preview matches what is paid', async () => {
  await addTicketLine(db, till, ticketId, { variantId: coke.variantId, unitId: coke.baseUnitId, quantity: '1' }, t);
  const q = await quoteTicket(db, till, ticketId, t);
  // 2 × GHS 45 + GHS 5 = GHS 95, + 10%
  expect(q).toMatchObject({ subtotalPesewas: 9500, serviceChargePesewas: 950, totalPesewas: 10450, lines: [{ name: 'Jollof', totalPesewas: 9000 }, { name: 'Coke', totalPesewas: 500 }] });
  expect(await saleOf(await payTicket(db, till, { ticketId, tenders: cash(q!.totalPesewas) }, t))).toMatchObject({ totalPesewas: q!.totalPesewas });
});

it('table mode needs a ticket and never comes from the outbox', async () => {
  const base = { saleId: randomUUID(), receiptNumber: 'B1-T1-000900', deviceCreatedAt: t.toISOString(), tenders: cash(9900),
    lines: [{ variantId: jollof.variantId, unitId: jollof.baseUnitId, quantity: '2', unitPricePesewas: 4500, discountPesewas: 0 }] };
  expect(await completeSale(db, till, { ...base, food: { serviceMode: 'table', diningOption: 'eat_in' } }, t)).toEqual({ ok: false, error: 'invalid_input' });
  expect(await completeSale(db, till, { ...base, fromOfflineOutbox: true, food: { serviceMode: 'table', diningOption: 'eat_in', ticketId } }, t)).toEqual({ ok: false, error: 'invalid_input' });
});

it("pays exactly the ticket's lines at today's prices", async () => {
  await printBill(db, till, ticketId, t);
  await addTicketLine(db, till, ticketId, { variantId: coke.variantId, unitId: coke.baseUnitId, quantity: '1' }, t);
  await asPlatform(db, (tx) => tx.update(variants).set({ basePricePesewas: 5000 }).where(eq(variants.id, jollof.variantId)));
  const r = await payTicket(db, till, { ticketId, tenders: cash(20000) }, t);
  // 2 × GHS 50 + GHS 5 = GHS 105, + GHS 10.50
  expect(await saleOf(r)).toMatchObject({ totalPesewas: 11550, serviceChargePesewas: 1050 });
  expect(await asPlatform(db, (tx) => tx.select().from(saleLines).where(eq(saleLines.saleId, (r as { saleId: string }).saleId)))).toHaveLength(2);
});

it('voided lines are not charged, and an underpaid bill is refused', async () => {
  await addTicketLine(db, till, ticketId, { variantId: coke.variantId, unitId: coke.baseUnitId, quantity: '1' }, t);
  await sendToKitchen(db, till, ticketId, t);
  const [{ id: cokeLine }] = await asPlatform(db, (tx) => tx.select({ id: ticketLines.id }).from(ticketLines).where(eq(ticketLines.variantId, coke.variantId)));
  await voidSentLine(db, till, { lineId: cokeLine, reason: 'Wrong drink', prepared: false, approverId: shop.users.manager.id, approverPin: '1234' }, t);
  expect(await payTicket(db, till, { ticketId, tenders: cash(9000) }, t)).toEqual({ ok: false, error: 'payment_incomplete' });
  expect(await saleOf(await payTicket(db, till, { ticketId, tenders: cash(9900) }, t))).toMatchObject({ totalPesewas: 9900 });
});

it('the ticket is paid and the table free; the receipt shows the service charge', async () => {
  const r = await payTicket(db, till, { ticketId, tenders: cash(10000) }, t);
  const [tk] = await asPlatform(db, (tx) => tx.select().from(tickets).where(eq(tickets.id, ticketId)));
  expect(tk).toMatchObject({ status: 'paid', saleId: (r as { saleId: string }).saleId });
  const [tb] = await asPlatform(db, (tx) => tx.select().from(diningTables).where(eq(diningTables.id, table1)));
  expect(tb.status).toBe('free');
  expect(await getReceipt(db, owner, (r as { saleId: string }).saleId, { reprint: false })).toMatchObject({ serviceChargePesewas: 900, totalPesewas: 9900 });
});
