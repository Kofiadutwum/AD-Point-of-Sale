import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { diningTables, products, wastageEntries } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { setServiceModes } from '@/server/food-settings';
import { saveTable } from '@/server/tables';
import {
  addTicketLine, cancelTicket, getTicket, listOpenTickets, moveTicketLines, openTicket, removeTicketLine, sendToKitchen, voidSentLine,
} from '@/server/tickets';
import { ctxFor, foodShop, productFor, type SeededShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t = new Date('2026-10-27T12:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let s: SeededShop & { packVariantId: string; packUnitId: string };
let owner: Ctx;
let till: Ctx;
let table1: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = s = await foodShop(db, t, { users: [
    { key: 'owner', email: 'o@x.test', rolePreset: 'owner', pin: '9999' }, { key: 'manager', email: 'm@x.test', rolePreset: 'manager', pin: '1234' },
    { key: 'cashier', email: 'c@x.test', rolePreset: 'cashier', pin: '5555' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t);
  await setServiceModes(db, owner, shop.branchId, ['counter', 'table']);
  table1 = (await saveTable(db, owner, { branchId: shop.branchId, name: 'Table 1', active: true }) as { tableId: string }).tableId;
  till = await tillCtxFor(db, shop, 'owner', t);
});
afterEach(async () => { await close(); });

const tableStatus = async (id: string) => (await asPlatform(db, (tx) => tx.select({ s: diningTables.status }).from(diningTables).where(eq(diningTables.id, id))))[0].s;

it('opens a ticket for a table and marks it ordering', async () => {
  const r = await openTicket(db, till, { tableId: table1, diningOption: 'eat_in' }, t);
  expect(r).toMatchObject({ ok: true });
  expect(await getTicket(db, till, (r as { ticketId: string }).ticketId)).toMatchObject({ label: 'Table 1', tableId: table1, status: 'open', waiterName: 'owner', lines: [] });
  expect(await tableStatus(table1)).toBe('ordering');
});

it('one open ticket per table, even at once', async () => {
  const [x, y] = await Promise.all([openTicket(db, till, { tableId: table1, diningOption: 'eat_in' }, t), openTicket(db, till, { tableId: table1, diningOption: 'eat_in' }, t)]);
  expect([x, y].filter((r) => r.ok)).toHaveLength(1);
  expect([x, y].find((r) => !r.ok)).toEqual({ ok: false, error: 'table_taken' });
});

it('opens a named ticket without a table', async () => {
  expect(await openTicket(db, till, { label: '  ', diningOption: 'eat_in' }, t)).toEqual({ ok: false, error: 'invalid_input' });
  const r = await openTicket(db, till, { label: 'Kofi', diningOption: 'takeaway' }, t);
  expect(r).toMatchObject({ ok: true });
  expect(await listOpenTickets(db, till, shop.branchId)).toMatchObject([{ label: 'Kofi', tableId: null, diningOption: 'takeaway', lineCount: 0 }]);
});

describe('lines', () => {
  let jollof: { variantId: string; baseUnitId: string };
  let coke: Awaited<ReturnType<typeof productFor>>;
  let ticketId: string;
  beforeEach(async () => {
    jollof = await productFor(db, owner, { name: 'Jollof', variants: [{ basePricePesewas: 3000, costPesewas: 1500 }] });
    coke = await productFor(db, owner, { name: 'Coke' });
    await asPlatform(db, (tx) => tx.update(products).set({ kitchenStation: 'bar' }).where(eq(products.id, coke.productId)));
    ticketId = (await openTicket(db, till, { tableId: table1, diningOption: 'eat_in' }, t) as { ticketId: string }).ticketId;
  });
  const add = (item: { variantId: string; baseUnitId: string }, extra = {}) =>
    addTicketLine(db, till, ticketId, { variantId: item.variantId, unitId: item.baseUnitId, quantity: '1', ...extra }, t);
  const lineIds = async () => (await getTicket(db, till, ticketId))!.lines.map((l) => l.id);

  it('adds items with a note at their station', async () => {
    expect(await add(jollof, { note: ' no pepper ' })).toMatchObject({ ok: true });
    expect(await add(coke)).toMatchObject({ ok: true });
    expect((await getTicket(db, till, ticketId))!.lines).toMatchObject([
      { lineNo: 1, name: 'Jollof', station: 'kitchen', note: 'no pepper', kitchenStatus: 'new' }, { lineNo: 2, name: 'Coke', station: 'bar' },
    ]);
    expect(await add({ variantId: s.packVariantId, baseUnitId: s.packUnitId })).toEqual({ ok: false, error: 'invalid_input' });
  });

  it('removes a new line but not a sent one', async () => {
    await add(jollof);
    await add(coke);
    const [first, second] = await lineIds();
    expect(await removeTicketLine(db, till, first)).toEqual({ ok: true });
    await sendToKitchen(db, till, ticketId, t);
    expect(await removeTicketLine(db, till, second)).toEqual({ ok: false, error: 'already_sent' });
  });

  it('sends only new lines and marks the table waiting for food', async () => {
    await add(jollof);
    await add(coke);
    expect(await sendToKitchen(db, till, ticketId, t)).toEqual({ ok: true, sent: { kitchen: 1, bar: 1, grill: 0 } });
    expect(await sendToKitchen(db, till, ticketId, t)).toEqual({ ok: false, error: 'nothing_new' });
    expect(await tableStatus(table1)).toBe('waiting_for_food');
  });

  it("void needs another person's manager PIN", async () => {
    await add(jollof);
    const [lineId] = await lineIds();
    const v = (approverKey: string, pin: string) => voidSentLine(db, till, { lineId, reason: 'Customer changed mind', prepared: false, approverId: s.users[approverKey].id, approverPin: pin }, t);
    expect(await v('manager', '1234')).toEqual({ ok: false, error: 'not_sent' });
    await sendToKitchen(db, till, ticketId, t);
    expect(await v('owner', '9999')).toEqual({ ok: false, error: 'self_approval' });
    expect(await v('cashier', '5555')).toEqual({ ok: false, error: 'not_authorised' });
    expect(await v('manager', '0000')).toEqual({ ok: false, error: 'wrong_pin' });
    expect(await v('manager', '1234')).toEqual({ ok: true });
    expect((await getTicket(db, till, ticketId))!.lines[0].kitchenStatus).toBe('void');
  });

  it('a prepared void records the dish as waste', async () => {
    await add(jollof);
    await sendToKitchen(db, till, ticketId, t);
    const [lineId] = await lineIds();
    await voidSentLine(db, till, { lineId, reason: 'Dropped', prepared: true, approverId: s.users.manager.id, approverPin: '1234' }, t);
    expect(await asPlatform(db, (tx) => tx.select().from(wastageEntries))).toMatchObject([{ variantId: jollof.variantId, reason: 'spoiled', quantity: '1.000', costPesewas: 1500 }]);
  });

  it('moves lines to another ticket', async () => {
    await add(jollof);
    await add(coke);
    const other = (await openTicket(db, till, { label: 'Bar', diningOption: 'eat_in' }, t) as { ticketId: string }).ticketId;
    const [, cokeLine] = await lineIds();
    expect(await moveTicketLines(db, till, { fromTicketId: ticketId, toTicketId: other, lineIds: [cokeLine] }, t)).toEqual({ ok: true, merged: false });
    expect((await getTicket(db, till, other))!.lines).toMatchObject([{ name: 'Coke', lineNo: 1 }]);
  });

  it('moving all lines merges and frees the table', async () => {
    await add(jollof);
    const other = (await openTicket(db, till, { label: 'Kofi', diningOption: 'eat_in' }, t) as { ticketId: string }).ticketId;
    expect(await moveTicketLines(db, till, { fromTicketId: ticketId, toTicketId: other, lineIds: await lineIds() }, t)).toEqual({ ok: true, merged: true });
    expect((await getTicket(db, till, ticketId))!.status).toBe('merged');
    expect(await tableStatus(table1)).toBe('free');
  });

  it('cancels a ticket with nothing sent; refuses once items went to the kitchen', async () => {
    await add(jollof);
    await sendToKitchen(db, till, ticketId, t);
    expect(await cancelTicket(db, till, ticketId, 'Left', t)).toEqual({ ok: false, error: 'has_sent_lines' });
    const other = (await openTicket(db, till, { label: 'Ama', diningOption: 'eat_in' }, t) as { ticketId: string }).ticketId;
    expect(await cancelTicket(db, till, other, 'Left', t)).toEqual({ ok: true });
  });
});

it('refuses when the branch has no table service', async () => {
  await setServiceModes(db, owner, shop.branchId, ['counter']);
  expect(await openTicket(db, till, { label: 'Kofi', diningOption: 'eat_in' }, t)).toEqual({ ok: false, error: 'mode_not_allowed' });
});
