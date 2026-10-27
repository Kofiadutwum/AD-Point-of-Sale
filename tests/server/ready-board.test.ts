import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { branches, registers, users } from '@/db/schema';
import { asPlatform } from '@/db/tenant';
import { type Ctx, requireContext } from '@/server/context';
import { handOverOrder, listKitchenOrders, markOrderReady } from '@/server/kitchen';
import { createBoardLink, handleBoardGet, readReadyBoard } from '@/server/ready-board';
import { completeSale } from '@/server/sales';
import { createSession } from '@/server/sessions';
import { ctxFor, foodShop, productFor, saleInput, type SeededShop, seedShop, tillCtxFor } from '../helpers/fixtures';
import { createTestDb } from '../helpers/test-db';

const t = new Date('2026-10-26T12:00:00Z');
const later = (min: number) => new Date(t.getTime() + min * 60_000);
let db: Db;
let close: () => Promise<void>;
let shop: SeededShop & { packVariantId: string; packUnitId: string };
let owner: Ctx;
let till: Ctx;
let jollof: { variantId: string; baseUnitId: string };
let token: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  shop = await foodShop(db, t);
  owner = await ctxFor(db, shop, 'owner', t);
  jollof = await productFor(db, owner, { name: 'Jollof', variants: [{ basePricePesewas: 3000, costPesewas: 1500 }] });
  till = await tillCtxFor(db, shop, 'owner', t);
  token = (await createBoardLink(db, owner, shop.branchId) as { token: string }).token;
});
afterEach(async () => { await close(); });

let receipt = 0;
async function order(ctx: Ctx, registerCode = 'T1', branchCode = 'B1'): Promise<{ id: string; number: string }> {
  const r = await completeSale(db, ctx, saleInput({
    receiptNumber: `${branchCode}-${registerCode}-${String(++receipt).padStart(6, '0')}`, deviceCreatedAt: t.toISOString(),
    lines: [{ variantId: jollof.variantId, unitId: jollof.baseUnitId, quantity: '1', unitPricePesewas: 3000, discountPesewas: 0 }],
    food: { serviceMode: 'counter', diningOption: 'eat_in' },
  }), t);
  if (!r.ok) throw new Error(r.error);
  const branchId = branchCode === 'B1' ? shop.branchId : (await asPlatform(db, (tx) => tx.select().from(branches).where(eq(branches.branchCode, branchCode))))[0].id;
  const list = await listKitchenOrders(db, ctx, branchId, t) as { orders: Array<{ id: string; orderNumber: string }> };
  return { id: list.orders.find((o) => o.orderNumber === r.orderNumber)!.id, number: r.orderNumber! };
}

it('shows numbers only, in two columns', async () => {
  const first = await order(till);
  await order(till);
  await markOrderReady(db, till, first.id, later(1));
  const board = await readReadyBoard(db, { slug: shop.slug, token }, later(2));
  expect(board).toEqual({ branchName: 'Main', preparing: ['002'], ready: ['001'] });
  expect(JSON.stringify(board)).not.toMatch(/Jollof|233|owner/);
});

it('a ready number goes after 10 minutes or once collected', async () => {
  const a = await order(till);
  const b = await order(till);
  await markOrderReady(db, till, a.id, t);
  await markOrderReady(db, till, b.id, later(1));
  expect((await readReadyBoard(db, { slug: shop.slug, token }, later(9)))!.ready).toEqual(['002', '001']); // newest first
  await handOverOrder(db, till, { orderId: b.id }, later(9));
  expect((await readReadyBoard(db, { slug: shop.slug, token }, later(9)))!.ready).toEqual(['001']);
  expect((await readReadyBoard(db, { slug: shop.slug, token }, later(11)))!.ready).toEqual([]);
});

it('a board link shows only its own branch', async () => {
  const [b2] = await asPlatform(db, (tx) => tx.insert(branches).values({ tenantId: shop.tenantId, name: 'Kumasi', branchCode: 'B2', serviceModes: ['counter'] }).returning());
  const [reg] = await asPlatform(db, (tx) => tx.insert(registers).values({ tenantId: shop.tenantId, branchId: b2.id, name: 'K1', registerCode: 'K1' }).returning());
  await asPlatform(db, (tx) => tx.update(users).set({ branchIds: [shop.branchId, b2.id] }).where(eq(users.id, shop.users.owner.id)));
  const { token: s } = await createSession(db, { tenantId: shop.tenantId, userId: shop.users.owner.id, kind: 'pin', registerId: reg.id }, t);
  await order(await requireContext(db, { slug: shop.slug, sessionToken: s, permission: null }, t), 'K1', 'B2');
  expect(await readReadyBoard(db, { slug: shop.slug, token }, t)).toEqual({ branchName: 'Main', preparing: [], ready: [] });
});

it("a wrong token, another shop's slug, or a replaced token shows nothing", async () => {
  await order(till);
  const other = await seedShop(db, { shopType: 'food' });
  expect(await readReadyBoard(db, { slug: shop.slug, token: 'nope' }, t)).toBeNull();
  expect(await readReadyBoard(db, { slug: other.slug, token }, t)).toBeNull();
  const fresh = (await createBoardLink(db, owner, shop.branchId) as { token: string }).token;
  expect(await readReadyBoard(db, { slug: shop.slug, token }, t)).toBeNull();
  expect(await readReadyBoard(db, { slug: shop.slug, token: fresh }, t)).not.toBeNull();
  expect((await handleBoardGet(db, shop.slug, 'nope', t)).status).toBe(404);
  const res = await handleBoardGet(db, shop.slug, fresh, t);
  expect([res.status, res.headers.get('cache-control')]).toEqual([200, 'no-store']);
});

it('only the token hash is stored', async () => {
  const [b] = await asPlatform(db, (tx) => tx.select().from(branches).where(eq(branches.id, shop.branchId)));
  expect(b.boardTokenHash).not.toBe(token);
  expect(b.boardTokenHash).toHaveLength(64);
});

it("refuses another shop's branch", async () => {
  const other = await seedShop(db, { shopType: 'food' });
  expect(await createBoardLink(db, owner, other.branchId)).toEqual({ ok: false, error: 'unknown_branch' });
});
