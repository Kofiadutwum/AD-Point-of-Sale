import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { branches, products, users } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { setServiceModes } from '@/server/food-settings';
import { listStationLines, markLineReady } from '@/server/kitchen-display';
import { addTicketLine, getTicket, openTicket, sendToKitchen } from '@/server/tickets';
import { ctxFor, foodShop, productFor, type SeededShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t = new Date('2026-10-27T12:00:00Z');
const later = new Date('2026-10-27T12:05:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let till: Ctx;
let jollof: Awaited<ReturnType<typeof productFor>>;
let coke: Awaited<ReturnType<typeof productFor>>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await foodShop(db, t);
  owner = await ctxFor(db, shop, 'owner', t);
  await setServiceModes(db, owner, shop.branchId, ['counter', 'table']);
  jollof = await productFor(db, owner, { name: 'Jollof' });
  coke = await productFor(db, owner, { name: 'Coke' });
  await asPlatform(db, (tx) => tx.update(products).set({ kitchenStation: 'bar' }).where(eq(products.id, coke.productId)));
  till = await tillCtxFor(db, shop, 'owner', t);
});
afterEach(async () => { await close(); });

async function sentTicket(label: string, at: Date) {
  const { ticketId } = await openTicket(db, till, { label, diningOption: 'eat_in' }, at) as { ticketId: string };
  await addTicketLine(db, till, ticketId, { variantId: jollof.variantId, unitId: jollof.baseUnitId, quantity: '2', note: 'no pepper' }, at);
  await addTicketLine(db, till, ticketId, { variantId: coke.variantId, unitId: coke.baseUnitId, quantity: '1' }, at);
  await sendToKitchen(db, till, ticketId, at);
  return ticketId;
}

it("shows only the station's sent lines, oldest ticket first", async () => {
  const second = await sentTicket('Ama', later);
  const first = await sentTicket('Kofi', t);
  expect(await listStationLines(db, owner, shop.branchId, 'kitchen')).toMatchObject([
    { ticketId: first, label: 'Kofi', lines: [{ name: 'Jollof', quantity: '2.000', note: 'no pepper' }] },
    { ticketId: second, label: 'Ama' },
  ]);
  expect((await listStationLines(db, owner, shop.branchId, 'bar')).flatMap((x) => x.lines.map((l) => l.name))).toEqual(['Coke', 'Coke']);
  expect(await listStationLines(db, owner, shop.branchId, 'grill')).toEqual([]);
});

it('marking ready moves a line off the display', async () => {
  const ticketId = await sentTicket('Kofi', t);
  const [line] = (await listStationLines(db, owner, shop.branchId, 'kitchen'))[0].lines;
  expect(await markLineReady(db, owner, line.lineId, later)).toEqual({ ok: true });
  expect(await listStationLines(db, owner, shop.branchId, 'kitchen')).toEqual([]);
  expect((await getTicket(db, till, ticketId))!.lines[0].kitchenStatus).toBe('ready');
  expect(await markLineReady(db, owner, line.lineId, later)).toEqual({ ok: false, error: 'not_sent' });
});

it("another branch's lines are not shown", async () => {
  await sentTicket('Kofi', t);
  const [b2] = await asPlatform(db, (tx) => tx.insert(branches).values({ tenantId: shop.tenantId, name: 'Kumasi', branchCode: 'B2', serviceModes: ['table'] }).returning());
  await asPlatform(db, (tx) => tx.update(users).set({ branchIds: [shop.branchId, b2.id] }).where(eq(users.id, shop.users.owner.id)));
  expect(await listStationLines(db, owner, b2.id, 'kitchen')).toEqual([]);
});
