import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { channelPayouts } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { listOpenReceivables, recordChannelPayout } from '@/server/channel-payouts';
import { saveChannel } from '@/server/channels';
import type { Ctx } from '@/server/context';
import { completeSale } from '@/server/sales';
import { ctxFor, expectAccess, foodShop, productFor, saleInput, type SeededShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t = new Date('2026-10-26T12:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop & { packVariantId: string; packUnitId: string };
let owner: Ctx;
let bolt: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await foodShop(db, t, { users: [{ key: 'owner', email: 'o@x.test', rolePreset: 'owner' }, { key: 'cashier', email: 'c@x.test', rolePreset: 'cashier' }] });
  owner = await ctxFor(db, shop, 'owner', t);
  const jollof = await productFor(db, owner, { name: 'Jollof', variants: [{ basePricePesewas: 4500, costPesewas: 2000 }] });
  bolt = (await saveChannel(db, owner, { name: 'Bolt Food', kind: 'delivery_app', priceListId: null, commissionBp: 2000, collectedBy: 'app', active: true }) as { channelId: string }).channelId;
  const till = await tillCtxFor(db, shop, 'owner', t);
  // two Bolt orders of GHS 46 (jollof + pack): 20% commission → GHS 36.80 owed for each
  for (const [i, orderId] of ['BF-1', 'BF-2'].entries()) {
    const r = await completeSale(db, till, saleInput({
      receiptNumber: `B1-T1-${String(i + 1).padStart(6, '0')}`, deviceCreatedAt: t.toISOString(),
      lines: [
        { variantId: jollof.variantId, unitId: jollof.baseUnitId, quantity: '1', unitPricePesewas: 4500, discountPesewas: 0 },
        { variantId: shop.packVariantId, unitId: shop.packUnitId, quantity: '1', unitPricePesewas: 100, discountPesewas: 0 },
      ],
      tenders: [{ id: randomUUID(), method: 'channel_settlement', amountPesewas: 4600, reference: orderId }],
      food: { serviceMode: 'counter', diningOption: 'delivery', channelId: bolt, externalOrderId: orderId },
    }), t);
    if (!r.ok) throw new Error(r.error);
  }
});
afterEach(async () => { await close(); });

const payout = (o: Partial<Parameters<typeof recordChannelPayout>[2]> = {}) => ({
  channelId: bolt, amountPesewas: 7000, reference: 'BOLT-W43', periodFrom: '2026-10-20', periodTo: '2026-10-26', ...o,
});

it('matches a payout to the period\'s open receivables and shows the difference', async () => {
  expect(await listOpenReceivables(db, owner, bolt)).toMatchObject([
    { receiptNumber: 'B1-T1-000001', externalOrderId: 'BF-1', businessDate: '2026-10-26', expectedPesewas: 3680 },
    { receiptNumber: 'B1-T1-000002', externalOrderId: 'BF-2', expectedPesewas: 3680 },
  ]);
  expect(await recordChannelPayout(db, owner, payout(), t)).toEqual({ ok: true, matched: 2, expectedPesewas: 7360, differencePesewas: -360 });
  expect(await listOpenReceivables(db, owner, bolt)).toEqual([]);
  expect(await asPlatform(db, (tx) => tx.select().from(channelPayouts))).toMatchObject([{ amountPesewas: 7000, expectedPesewas: 7360, differencePesewas: -360 }]);
});

it('a receivable is matched once', async () => {
  await recordChannelPayout(db, owner, payout(), t);
  expect(await recordChannelPayout(db, owner, payout({ reference: 'BOLT-W43b' }), t)).toEqual({ ok: false, error: 'nothing_to_match' });
  expect(await recordChannelPayout(db, owner, payout({ reference: 'OLD', periodFrom: '2026-10-01', periodTo: '2026-10-19' }), t)).toEqual({ ok: false, error: 'nothing_to_match' });
});

it('refuses a reused payout reference or a bad period', async () => {
  await recordChannelPayout(db, owner, payout(), t);
  expect(await recordChannelPayout(db, owner, payout({ periodFrom: '2026-10-27', periodTo: '2026-10-28' }), t)).toEqual({ ok: false, error: 'duplicate_reference' });
  expect(await recordChannelPayout(db, owner, payout({ reference: 'X', periodFrom: '2026-10-26', periodTo: '2026-10-20' }), t)).toEqual({ ok: false, error: 'invalid_input' });
  expect(await recordChannelPayout(db, owner, payout({ channelId: randomUUID(), reference: 'Y' }), t)).toEqual({ ok: false, error: 'unknown_channel' });
});

it('a cashier cannot record payouts', async () => {
  const cashier = await ctxFor(db, shop, 'cashier', t);
  await expectAccess(recordChannelPayout(db, cashier, payout(), t), 'forbidden');
  await expectAccess(listOpenReceivables(db, cashier, bolt), 'forbidden');
});
