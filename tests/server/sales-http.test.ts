import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { users } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import type { Ctx } from '@/server/context';
import { registerDevice } from '@/server/devices';
import { handleCounterGet, handleSalePost } from '@/server/sales-http';
import { createSession } from '@/server/sessions';
import { ctxFor, productFor, saleInput, type SeededShop, seedShop } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t0 = new Date('2026-10-20T10:00:00Z');
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop;
let owner: Ctx;
let p: { variantId: string; baseUnitId: string };
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await seedShop(db, { users: [
    { key: 'owner', email: 'o@a.test', password: 'correct-horse-1', rolePreset: 'owner' },
    { key: 'cashier', phone: '0200000001', pin: '1234', rolePreset: 'cashier' },
  ] });
  owner = await ctxFor(db, shop, 'owner', t0);
  p = await productFor(db, owner);
});
afterEach(async () => { await close(); });

const session = async (key: string, kind: 'pin' | 'password', s = shop) =>
  `pos_session=${(await createSession(db, { tenantId: s.tenantId, userId: s.users[key].id, kind, registerId: kind === 'pin' ? s.registerId : null }, t0)).token}`;
const device = async () => `pos_device=${((await registerDevice(db, owner, shop.registerId, t0)) as { deviceToken: string }).deviceToken}`;
const post = (cookie: string, body: unknown, contentType = 'application/json') => new Request(`http://x/api/${shop.slug}/sales`, {
  method: 'POST', headers: { cookie, 'content-type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const get = (cookie: string) => new Request(`http://x/api/${shop.slug}/register/counter`, { headers: { cookie } });
const sale = (extra = {}) => saleInput({ lines: [{ variantId: p.variantId, unitId: p.baseUnitId, quantity: '1', unitPricePesewas: 500, discountPesewas: 0 }],
  tenders: [{ id: crypto.randomUUID(), method: 'cash', amountPesewas: 500 }], ...extra });

it('completes a sale for a PIN session and returns the contract JSON', async () => {
  const input = sale();
  const res = await handleSalePost(db, post(await session('cashier', 'pin'), input), shop.slug, t0);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, saleId: input.saleId, status: 'completed', changeDuePesewas: 0, alreadyExisted: false });
  const again = await handleSalePost(db, post(await session('cashier', 'pin'), input), shop.slug, t0);
  expect(await again.json()).toMatchObject({ ok: true, alreadyExisted: true });
});

it('a password session sells on the registered device in its cookie', async () => {
  const pw = await session('owner', 'password');
  expect((await handleSalePost(db, post(`${pw}; ${await device()}`, sale()), shop.slug, t0)).status).toBe(200);
  const res = await handleSalePost(db, post(pw, sale()), shop.slug, t0);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ ok: false, error: 'no_register' });
});

it('maps errors to status codes', async () => {
  const pin = await session('cashier', 'pin');
  expect((await handleSalePost(db, post('', sale()), shop.slug, t0)).status).toBe(401);
  const b = await seedShop(db, { slug: 'shop-b' });
  expect((await handleSalePost(db, post(await session('owner', 'password', b), sale()), shop.slug, t0)).status).toBe(401);
  await asPlatform(db, (tx) => tx.update(users).set({ permissions: [] }).where(eq(users.id, shop.users.cashier.id)));
  expect((await handleSalePost(db, post(pin, sale()), shop.slug, t0)).status).toBe(403);
  await asPlatform(db, (tx) => tx.update(users).set({ permissions: ['make_sale'] }).where(eq(users.id, shop.users.cashier.id)));
  expect((await handleSalePost(db, post(pin, 'not json'), shop.slug, t0)).status).toBe(400);
  expect((await handleSalePost(db, post(pin, sale(), 'text/plain'), shop.slug, t0)).status).toBe(400);
  expect((await handleSalePost(db, post(pin, { ...sale(), saleId: 'x' }), shop.slug, t0)).status).toBe(400);
  const changed = await handleSalePost(db, post(pin, sale({ lines: [{ variantId: p.variantId, unitId: p.baseUnitId, quantity: '1', unitPricePesewas: 1, discountPesewas: 0 }] })), shop.slug, t0);
  expect(changed.status).toBe(409);
  expect(await changed.json()).toEqual({ ok: false, error: 'price_changed' });
});

it('returns the register counter by device cookie alone', async () => {
  const dev = await device();
  expect(await (await handleCounterGet(db, get(dev), shop.slug, t0)).json()).toEqual({ registerCode: 'T1', lastCounter: 0 });
  await handleSalePost(db, post(await session('cashier', 'pin'), sale({ receiptNumber: 'B1-T1-000041' })), shop.slug, t0);
  const res = await handleCounterGet(db, get(dev), shop.slug, t0);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ registerCode: 'T1', lastCounter: 41 });
  expect((await handleCounterGet(db, get(dev), 'shop-b', t0)).status).toBe(401);
  expect((await handleCounterGet(db, get(await session('owner', 'password')), shop.slug, t0)).status).toBe(409);
  expect(await (await handleCounterGet(db, get(await session('cashier', 'pin')), shop.slug, t0)).json()).toEqual({ registerCode: 'T1', lastCounter: 41 });
});
