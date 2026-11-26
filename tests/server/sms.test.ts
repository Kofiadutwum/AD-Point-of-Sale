import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { notifications, tenants } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { smsParts } from '@/lib/sms-text';
import type { Ctx } from '@/server/context';
import { addCustomer } from '@/server/customers';
import { listCampaigns, optOut, outsideQuietHours, previewCampaign, sendCampaign, setMarketingConsent } from '@/server/marketing';
import { queueDueReports, runNotifications } from '@/server/notifications';
import { completeSale } from '@/server/sales';
import { saveReportSettings } from '@/server/shop-settings';
import { ctxFor, expectAccess, productFor, saleInput, type SeededShop, seedShop, stockFor, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-11-26T12:00:00Z'); // a Thursday; Accra is UTC
const at = (hhmm: string) => new Date(`2026-11-26T${hhmm}:00Z`);
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let cashier: Ctx;
let ama: string;
let kofi: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@s.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'cashier', phone: '0200000001', pin: '1234', rolePreset: 'cashier' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  cashier = await tillCtxFor(db, shop, 'cashier', t0);
  const p = await productFor(db, owner); // GHS 5.00
  await stockFor(db, owner, shop.branchId, { variantId: p.variantId, unitId: p.baseUnitId, quantity: '10', totalCostPesewas: 2000 }, t0);
  ama = ((await addCustomer(db, owner, { name: 'Ama', phone: '0244000001' })) as { customerId: string }).customerId;
  kofi = ((await addCustomer(db, owner, { name: 'Kofi', phone: '0244000002' })) as { customerId: string }).customerId;
  await addCustomer(db, owner, { name: 'Esi', phone: '0244000003' }); // never agreed
  const line = { variantId: p.variantId, unitId: p.baseUnitId, quantity: '2', unitPricePesewas: 500, discountPesewas: 0 };
  expect(await completeSale(db, cashier, saleInput({ lines: [line], customerId: ama, tenders: [{ id: randomUUID(), method: 'cash', amountPesewas: 1000 }], deviceCreatedAt: t0.toISOString() }), t0)).toMatchObject({ ok: true });
});
afterEach(async () => { await close(); });

const all = () => asPlatform(db, (tx) => tx.select().from(notifications));

it('counts SMS parts', () => {
  expect(smsParts('a'.repeat(160))).toBe(1);
  expect(smsParts('a'.repeat(161))).toBe(2);
  expect(smsParts('₵'.repeat(71))).toBe(2);
});

it('queues the daily and weekly reports once after the report time, then sends them', async () => {
  expect(await saveReportSettings(db, owner, { smsReports: true, reportTime: '20:00', weeklyReportDay: 4 })).toEqual({ ok: true });
  await asPlatform(db, (tx) => tx.update(tenants).set({ managerPhone: '233244111222' }).where(eq(tenants.id, shop.tenantId)));
  expect(await queueDueReports(db, at('19:59'))).toBe(0);
  expect(await queueDueReports(db, at('20:15'))).toBe(2);
  expect(await queueDueReports(db, at('20:30'))).toBe(0); // job ran twice: nothing doubled
  const sent: Array<[string, string]> = [];
  expect(await runNotifications(db, at('20:31'), async (to, text) => { sent.push([to, text]); })).toEqual({ sent: 2, failed: 0, blocked: 0 });
  expect(sent.map(([to]) => to)).toEqual(['233244111222', '233244111222']);
  expect(sent.find(([, t]) => t.includes('Sales'))![1]).toContain('Sales GHS 10.00 (1), refunds GHS 0.00, net GHS 10.00');
  expect(sent.find(([, t]) => t.includes('stock'))![1]).toContain('Out of stock 0');
});

it('retries a failing SMS three times, and blocks SMS past the allowance', async () => {
  await asPlatform(db, (tx) => tx.insert(notifications).values({ tenantId: shop.tenantId, key: 'x', kind: 'report', toPhone: '233244111222', body: 'hi', parts: 1, sendAfter: t0 }));
  const boom = async () => { throw new Error('provider down'); };
  expect(await runNotifications(db, t0, boom)).toMatchObject({ failed: 1 });
  expect(await runNotifications(db, t0, boom)).toMatchObject({ failed: 0 }); // waits 5 minutes
  await runNotifications(db, at('12:06'), boom);
  await runNotifications(db, at('12:12'), boom);
  expect((await all())[0]).toMatchObject({ status: 'failed', attempts: 3, error: 'provider down' });
  await asPlatform(db, (tx) => tx.insert(notifications).values([
    { tenantId: shop.tenantId, key: 'used', kind: 'report', toPhone: '233244111222', body: 'x', parts: 500, sendAfter: t0, status: 'sent', sentAt: t0 },
    { tenantId: shop.tenantId, key: 'over', kind: 'report', toPhone: '233244111222', body: 'x', parts: 1, sendAfter: t0 },
  ]));
  expect(await runNotifications(db, t0, async () => {})).toMatchObject({ sent: 0, blocked: 1 });
});

it('campaigns go only to opted-in customers in the segment, with the cost confirmed, never at night', async () => {
  expect(await setMarketingConsent(db, owner, ama, true)).toEqual({ ok: true });
  expect(await setMarketingConsent(db, owner, kofi, true)).toEqual({ ok: true });
  const p = await previewCampaign(db, owner, { segment: 'all', message: 'Christmas sale: 10% off' }, t0) as { preview: { recipients: number; totalParts: number; text: string } };
  expect(p.preview).toMatchObject({ recipients: 2, totalParts: 2 });
  expect(p.preview.text).toContain(`/${shop.slug}/stop`);
  expect(await previewCampaign(db, owner, { segment: 'recent', message: 'Hi' }, t0)).toMatchObject({ preview: { recipients: 1 } });
  expect(await previewCampaign(db, owner, { segment: 'lapsed', message: 'Hi' }, t0)).toMatchObject({ preview: { recipients: 0 } });
  expect(await sendCampaign(db, owner, { segment: 'all', message: 'Christmas sale: 10% off', confirmedParts: 1 }, t0)).toEqual({ ok: false, error: 'cost_changed' });
  const night = at('22:30');
  expect(await sendCampaign(db, owner, { segment: 'all', message: 'Christmas sale: 10% off', confirmedParts: 2 }, night)).toMatchObject({ ok: true, recipients: 2, sendAfter: new Date('2026-11-27T07:00:00Z') });
  expect(await runNotifications(db, night, async () => {})).toMatchObject({ sent: 0 });
  expect(outsideQuietHours('Africa/Accra', at('06:59'))).toEqual(at('07:00'));
  expect(outsideQuietHours('Africa/Accra', at('12:00'))).toEqual(at('12:00'));
  await expectAccess(previewCampaign(db, cashier, { segment: 'all', message: 'Hi' }, t0), 'forbidden');
});

it('an opt-out stops queued and future promotional SMS, and staff cannot undo it', async () => {
  await setMarketingConsent(db, owner, kofi, true);
  await sendCampaign(db, owner, { segment: 'all', message: 'Hi', confirmedParts: 1 }, t0);
  expect(await optOut(db, shop.slug, '024 400 0002', t0)).toEqual({ ok: true });
  expect((await all())[0]).toMatchObject({ status: 'failed', error: 'opted out' });
  expect(await setMarketingConsent(db, owner, kofi, true)).toEqual({ ok: false, error: 'opted_out' });
  expect(await previewCampaign(db, owner, { segment: 'all', message: 'Hi' }, t0)).toMatchObject({ preview: { recipients: 0 } });
  await setMarketingConsent(db, owner, ama, true); // another customer's opt-out does not stop Ama
  expect(await previewCampaign(db, owner, { segment: 'all', message: 'Hi' }, t0)).toMatchObject({ preview: { recipients: 1 } });
  await sendCampaign(db, owner, { segment: 'all', message: 'Hello', confirmedParts: 1 }, t0);
  await runNotifications(db, t0, async () => {});
  expect((await listCampaigns(db, owner)).map((c) => [c.message, c.recipients, c.sent])).toEqual([['Hello', 1, 1], ['Hi', 1, 0]]);
  expect(await optOut(db, shop.slug, '123', t0)).toEqual({ ok: false, error: 'invalid_phone' });
});
