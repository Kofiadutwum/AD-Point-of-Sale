import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { diningTables } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { setServiceModes } from '@/server/food-settings';
import { saveTable } from '@/server/tables';
import { getTicket, listOpenTickets, openTicket } from '@/server/tickets';
import { ctxFor, foodShop, type SeededShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t = new Date('2026-10-27T12:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let till: Ctx;
let table1: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await foodShop(db, t);
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

it('refuses when the branch has no table service', async () => {
  await setServiceModes(db, owner, shop.branchId, ['counter']);
  expect(await openTicket(db, till, { label: 'Kofi', diningOption: 'eat_in' }, t)).toEqual({ ok: false, error: 'mode_not_allowed' });
});
