import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { listChannels, saveChannel } from '@/server/channels';
import type { Ctx } from '@/server/context';
import { createPriceList } from '@/server/price-lists';
import { ctxFor, expectAccess, type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-26T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { shopType: 'food', users: [
    { key: 'owner', email: 'o@x.test', rolePreset: 'owner' }, { key: 'cashier', email: 'c@x.test', rolePreset: 'cashier' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
});
afterEach(async () => { await close(); });

const bolt = { name: 'Bolt Food', kind: 'delivery_app' as const, priceListId: null, commissionBp: 2250, collectedBy: 'app' as const, active: true };
const list = async (ctx: Ctx) => (await createPriceList(db, ctx, { name: 'Bolt prices', kind: 'wholesale', branchId: null, startsOn: null, endsOn: null }) as { priceListId: string }).priceListId;

it('adds Bolt Food with a price list and 22.5% commission', async () => {
  const priceListId = await list(owner);
  const r = await saveChannel(db, owner, { ...bolt, priceListId });
  expect(r).toMatchObject({ ok: true });
  expect(await listChannels(db, owner)).toEqual([{ id: (r as { channelId: string }).channelId, ...bolt, priceListId }]);
});

it("refuses another shop's price list", async () => {
  const other = await seedShop(db, { shopType: 'food' });
  const foreign = await list(await ctxFor(db, other, 'owner', t0));
  expect(await saveChannel(db, owner, { ...bolt, priceListId: foreign })).toMatchObject({ ok: false, error: 'unknown_price_list' });
});

it('refuses a duplicate name in any case', async () => {
  await saveChannel(db, owner, bolt);
  expect(await saveChannel(db, owner, { ...bolt, name: 'BOLT FOOD' })).toMatchObject({ ok: false, error: 'duplicate_name' });
});

it('a phone channel is always collected by the shop', async () => {
  const r = await saveChannel(db, owner, { ...bolt, name: 'Phone', kind: 'phone', commissionBp: 0 });
  expect(r).toMatchObject({ ok: true });
  expect((await listChannels(db, owner)).find((c) => c.name === 'Phone')!.collectedBy).toBe('shop');
});

it('edits a channel and makes it inactive instead of deleting it', async () => {
  const { channelId } = await saveChannel(db, owner, bolt) as { channelId: string };
  expect(await saveChannel(db, owner, { ...bolt, id: channelId, commissionBp: 2000, active: false })).toEqual({ ok: true, channelId });
  expect(await listChannels(db, owner)).toMatchObject([{ id: channelId, commissionBp: 2000, active: false }]);
});

it('a cashier cannot set up channels', async () => {
  await expectAccess(saveChannel(db, await ctxFor(db, shop, 'cashier', t0), bolt), 'forbidden');
});
