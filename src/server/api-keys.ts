import 'server-only';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { and, asc, between, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { API_SCOPES, type ApiScope, apiKeys, onlineOrders, products, saleLines, sales, stockBalances, tenants, variants } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { tokenHash } from './crypto';
import { type Fail, fail, isUuid } from './products';

// Spec 4.29: per-shop API keys with limited, read-only scopes. The key is shown once; only its hash is kept.

const MAX_KEYS = 10;
const KEY = /^ads_([0-9a-f]{8})_([A-Za-z0-9_-]{32,64})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SALE_DAYS = 31;

export async function listApiKeys(db: Db, ctx: Ctx) {
  assertPermission(ctx, 'manage_integrations');
  return withTenant(db, ctx.tenantId, (tx) => tx.select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, scopes: apiKeys.scopes, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt, createdAt: apiKeys.createdAt })
    .from(apiKeys).orderBy(desc(apiKeys.createdAt)));
}

export async function createApiKey(db: Db, ctx: Ctx, input: { name: string; scopes: string[] }): Promise<{ ok: true; key: string } | Fail<'invalid_input' | 'limit_reached'>> {
  assertPermission(ctx, 'manage_integrations');
  const name = input.name?.trim().slice(0, 60) ?? '';
  const scopes = [...new Set(input.scopes)].filter((s): s is ApiScope => (API_SCOPES as readonly string[]).includes(s));
  if (!name || !scopes.length) return fail('invalid_input');
  const prefix = randomBytes(4).toString('hex');
  const key = `ads_${prefix}_${randomBytes(32).toString('base64url')}`;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const live = await tx.select({ id: apiKeys.id }).from(apiKeys).where(isNull(apiKeys.revokedAt));
    if (live.length >= MAX_KEYS) return fail('limit_reached');
    const [k] = await tx.insert(apiKeys).values({ tenantId: ctx.tenantId, name, prefix, keyHash: tokenHash(key), scopes, createdBy: ctx.userId }).returning({ id: apiKeys.id });
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'api_key_created', recordType: 'api_key', recordId: k.id, changes: { name, prefix, scopes } });
    return { ok: true as const, key };
  });
}

export async function revokeApiKey(db: Db, ctx: Ctx, id: string, now: Date): Promise<{ ok: true } | Fail<'not_found'>> {
  assertPermission(ctx, 'manage_integrations');
  if (!isUuid(id)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const done = await tx.update(apiKeys).set({ revokedAt: now }).where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt))).returning({ id: apiKeys.id });
    if (!done.length) return fail('not_found');
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'api_key_revoked', recordType: 'api_key', recordId: id });
    return { ok: true as const };
  });
}

/** Finds the shop for a bearer key; a revoked key, a closed shop, or a wrong secret all look the same. */
export async function authenticateKey(db: Db, header: string | null, now: Date): Promise<{ tenantId: string; scopes: ApiScope[] } | null> {
  const key = header?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';
  const m = KEY.exec(key);
  if (!m) return null;
  return asPlatform(db, async (tx) => {
    const [k] = await tx.select({ id: apiKeys.id, tenantId: apiKeys.tenantId, hash: apiKeys.keyHash, scopes: apiKeys.scopes, revokedAt: apiKeys.revokedAt, lastUsedAt: apiKeys.lastUsedAt, status: tenants.status })
      .from(apiKeys).innerJoin(tenants, eq(tenants.id, apiKeys.tenantId)).where(eq(apiKeys.prefix, m[1]));
    if (!k || k.revokedAt || k.status !== 'active') return null;
    const a = Buffer.from(k.hash);
    const b = Buffer.from(tokenHash(key));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (!k.lastUsedAt || now.getTime() - k.lastUsedAt.getTime() > 5 * 60_000) await tx.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, k.id));
    return { tenantId: k.tenantId, scopes: k.scopes };
  });
}

export const RESOURCES = { products: 'products:read', stock: 'stock:read', sales: 'sales:read', orders: 'orders:read' } as const satisfies Record<string, ApiScope>;
export type Resource = keyof typeof RESOURCES;

/** Read-only data for one resource; never costs, staff, customer details or secrets. */
export async function apiRead(db: Db, tenantId: string, resource: Resource, query: { from?: string | null; to?: string | null }): Promise<{ ok: true; data: unknown[] } | Fail<'invalid_range'>> {
  if (resource === 'sales') {
    const from = query.from ?? '';
    const to = query.to ?? '';
    if (!DAY.test(from) || !DAY.test(to) || to < from || (Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_SALE_DAYS) return fail('invalid_range');
  }
  return withTenant(db, tenantId, async (tx) => {
    if (resource === 'products') {
      const rows = await tx.select({ productId: products.id, product: products.name, variantId: variants.id, variant: variants.name, sku: variants.sku, pricePesewas: variants.basePricePesewas, status: variants.status })
        .from(variants).innerJoin(products, eq(products.id, variants.productId)).orderBy(asc(products.name), asc(variants.name)).limit(5000);
      return { ok: true as const, data: rows };
    }
    if (resource === 'stock') {
      const rows = await tx.select({ branchId: stockBalances.branchId, variantId: stockBalances.variantId, onHand: stockBalances.onHand, reserved: stockBalances.reserved }).from(stockBalances).limit(20000);
      return { ok: true as const, data: rows };
    }
    if (resource === 'orders') {
      const rows = await tx.select({ id: onlineOrders.id, number: onlineOrders.number, status: onlineOrders.status, source: onlineOrders.source, fulfilment: onlineOrders.fulfilment, totalPesewas: onlineOrders.totalPesewas, lines: onlineOrders.lines, createdAt: onlineOrders.createdAt })
        .from(onlineOrders).orderBy(desc(onlineOrders.createdAt)).limit(500);
      return { ok: true as const, data: rows };
    }
    const list = await tx.select({ id: sales.id, receiptNumber: sales.receiptNumber, branchId: sales.branchId, businessDate: sales.businessDate, totalPesewas: sales.totalPesewas, taxPesewas: sales.taxPesewas, discountPesewas: sales.discountPesewas, completedAt: sales.completedAt })
      .from(sales).where(and(eq(sales.status, 'completed'), between(sales.businessDate, query.from!, query.to!))).orderBy(asc(sales.businessDate), asc(sales.receiptNumber)).limit(5000);
    const lines = list.length ? await tx.select({ saleId: saleLines.saleId, variantId: saleLines.variantId, name: saleLines.name, quantity: saleLines.quantity, totalPesewas: saleLines.totalPesewas })
      .from(saleLines).where(inArray(saleLines.saleId, list.map((s) => s.id))) : [];
    return { ok: true as const, data: list.map((s) => ({ ...s, lines: lines.filter((l) => l.saleId === s.id).map((l) => ({ variantId: l.variantId, name: l.name, quantity: l.quantity, totalPesewas: l.totalPesewas })) })) };
  });
}
