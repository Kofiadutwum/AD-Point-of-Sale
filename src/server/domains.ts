import 'server-only';
import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { shopDomains, tenants } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, isUuid } from './products';

// Spec 3: subdomains (slug.ROOT_DOMAIN) need only wildcard DNS; a custom domain is proved by a TXT record before it serves the shop.
// Certificates come from the host (e.g. Caddy on-demand TLS asks /api/domains/allowed, or the hosting provider's domain list).

const HOST = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const rootDomain = () => process.env.ROOT_DOMAIN?.toLowerCase() || null;
export const txtName = (host: string) => `_adsmartshop.${host}`;

export type TxtResolver = (name: string) => Promise<string[][]>;

export async function listDomains(db: Db, ctx: Ctx) {
  assertPermission(ctx, 'manage_integrations');
  const rows = await withTenant(db, ctx.tenantId, (tx) => tx.select().from(shopDomains));
  const root = rootDomain();
  return { subdomain: root ? `${ctx.slug}.${root}` : null, domains: rows.map((d) => ({ id: d.id, host: d.host, verified: !!d.verifiedAt, txtName: txtName(d.host), txtValue: d.verifyToken })) };
}

export async function addDomain(db: Db, ctx: Ctx, rawHost: string): Promise<{ ok: true; id: string } | Fail<'invalid_host' | 'taken' | 'limit_reached'>> {
  assertPermission(ctx, 'manage_integrations');
  const host = rawHost?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '') ?? '';
  const root = rootDomain();
  if (!HOST.test(host) || (root && (host === root || host.endsWith(`.${root}`)))) return fail('invalid_host');
  const taken = await asPlatform(db, async (tx) => (await tx.select({ id: shopDomains.id }).from(shopDomains).where(eq(shopDomains.host, host))).length > 0);
  if (taken) return fail('taken');
  return withTenant(db, ctx.tenantId, async (tx) => {
    if ((await tx.select({ id: shopDomains.id }).from(shopDomains)).length >= 3) return fail('limit_reached');
    const [d] = await tx.insert(shopDomains).values({ tenantId: ctx.tenantId, host, verifyToken: `ads-verify-${randomBytes(16).toString('hex')}` }).returning({ id: shopDomains.id });
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'domain_added', recordType: 'shop_domain', recordId: d.id, changes: { host } });
    return { ok: true as const, id: d.id };
  });
}

/** Looks up the TXT record; the domain goes live once it holds the token. */
export async function verifyDomain(db: Db, ctx: Ctx, id: string, now: Date, resolve: TxtResolver = resolveTxt): Promise<{ ok: true } | Fail<'not_found' | 'not_verified'>> {
  assertPermission(ctx, 'manage_integrations');
  if (!isUuid(id)) return fail('not_found');
  const [d] = await withTenant(db, ctx.tenantId, (tx) => tx.select().from(shopDomains).where(eq(shopDomains.id, id)));
  if (!d) return fail('not_found');
  let records: string[][] = [];
  try { records = await resolve(txtName(d.host)); } catch { records = []; }
  if (!records.some((r) => r.join('') === d.verifyToken)) return fail('not_verified');
  await withTenant(db, ctx.tenantId, async (tx) => {
    await tx.update(shopDomains).set({ verifiedAt: now }).where(eq(shopDomains.id, id));
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'domain_verified', recordType: 'shop_domain', recordId: id, changes: { host: d.host } });
  });
  return { ok: true };
}

export async function removeDomain(db: Db, ctx: Ctx, id: string): Promise<{ ok: true } | Fail<'not_found'>> {
  assertPermission(ctx, 'manage_integrations');
  if (!isUuid(id)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const gone = await tx.delete(shopDomains).where(eq(shopDomains.id, id)).returning({ host: shopDomains.host });
    if (!gone.length) return fail('not_found');
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'domain_removed', recordType: 'shop_domain', recordId: id, changes: { host: gone[0].host } });
    return { ok: true as const };
  });
}

/** The shop slug a request host belongs to: slug.ROOT_DOMAIN, or a verified custom domain of an active shop. */
export async function slugForHost(db: Db, rawHost: string): Promise<string | null> {
  const host = rawHost.toLowerCase().replace(/:\d+$/, '');
  const root = rootDomain();
  if (root && host.endsWith(`.${root}`)) {
    const sub = host.slice(0, -root.length - 1);
    if (!/^[a-z0-9-]{3,40}$/.test(sub) || sub === 'www') return null;
    const [t] = await asPlatform(db, (tx) => tx.select({ slug: tenants.slug }).from(tenants).where(and(eq(tenants.slug, sub), eq(tenants.status, 'active'))));
    return t?.slug ?? null;
  }
  if (!HOST.test(host)) return null;
  const [t] = await asPlatform(db, (tx) => tx.select({ slug: tenants.slug }).from(shopDomains).innerJoin(tenants, eq(tenants.id, shopDomains.tenantId))
    .where(and(eq(shopDomains.host, host), isNotNull(shopDomains.verifiedAt), eq(tenants.status, 'active'))));
  return t?.slug ?? null;
}
