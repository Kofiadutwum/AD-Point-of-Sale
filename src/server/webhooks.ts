import 'server-only';
import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { and, arrayContains, asc, desc, eq, lte } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { WEBHOOK_EVENTS, type WebhookEvent, webhookDeliveries, webhookEndpoints } from '@/db/schema';
import { asPlatform, withTenant } from '@/db/tenant';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { type Fail, fail, isUuid } from './products';
import { openSecret, sealSecret } from './secret-box';

// Spec 4.29: outgoing webhooks for sale completed, stock low and order created.
// Each delivery is signed: x-webhook-signature = hex HMAC-SHA256 of "<timestamp>.<body>" with the endpoint's secret.

const MAX_ENDPOINTS = 5;
const MAX_ATTEMPTS = 8;
const backoffMinutes = (attempt: number) => Math.min(2 ** attempt, 24 * 60); // 2, 4, 8 … minutes, at most a day

/** Blocks loopback, private, link-local and metadata addresses so a shop cannot make the server call its own network. */
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
    return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** https only, a public host name (no bare IPs, no localhost), no credentials, standard port. */
export function checkEndpointUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || raw.length > 500) return null;
  const host = u.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, '')) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) return null;
  return u;
}

export type Resolver = (host: string) => Promise<string[]>;
const liveResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);
export type Poster = (url: string, init: { headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;
const livePoster: Poster = async (url, init) => {
  const r = await fetch(url, { method: 'POST', headers: init.headers, body: init.body, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  return { ok: r.ok, status: r.status };
};

export const signDelivery = (secret: string, timestamp: string, body: string) => createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

/** Queues the event for every active endpoint that wants it, inside the caller's transaction (so it is sent only if the change commits). */
export async function emitEvent(tx: Tx, tenantId: string, event: WebhookEvent, payload: Record<string, unknown>, now: Date): Promise<void> {
  const endpoints = await tx.select({ id: webhookEndpoints.id }).from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.active, true), arrayContains(webhookEndpoints.events, [event])));
  if (!endpoints.length) return;
  await tx.insert(webhookDeliveries).values(endpoints.map((e) => ({ tenantId, endpointId: e.id, event, payload, nextAttemptAt: now, createdAt: now })));
}

export async function listEndpoints(db: Db, ctx: Ctx) {
  assertPermission(ctx, 'manage_integrations');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const endpoints = await tx.select({ id: webhookEndpoints.id, url: webhookEndpoints.url, events: webhookEndpoints.events, active: webhookEndpoints.active, createdAt: webhookEndpoints.createdAt })
      .from(webhookEndpoints).orderBy(asc(webhookEndpoints.createdAt));
    const recent = await tx.select({ id: webhookDeliveries.id, endpointId: webhookDeliveries.endpointId, event: webhookDeliveries.event, status: webhookDeliveries.status, attempts: webhookDeliveries.attempts, lastError: webhookDeliveries.lastError, createdAt: webhookDeliveries.createdAt })
      .from(webhookDeliveries).orderBy(desc(webhookDeliveries.createdAt)).limit(30);
    return { endpoints, recent };
  });
}

/** The signing secret is returned once, here; afterwards only the server can read it. */
export async function addEndpoint(db: Db, ctx: Ctx, input: { url: string; events: string[] }): Promise<{ ok: true; id: string; secret: string } | Fail<'invalid_url' | 'invalid_input' | 'limit_reached'>> {
  assertPermission(ctx, 'manage_integrations');
  const u = checkEndpointUrl(input.url ?? '');
  if (!u) return fail('invalid_url');
  const events = [...new Set(input.events)].filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (!events.length) return fail('invalid_input');
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const existing = await tx.select({ id: webhookEndpoints.id }).from(webhookEndpoints);
    if (existing.length >= MAX_ENDPOINTS) return fail('limit_reached');
    const [e] = await tx.insert(webhookEndpoints).values({ tenantId: ctx.tenantId, url: u.toString(), secretSealed: sealSecret(secret), events }).returning({ id: webhookEndpoints.id });
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'webhook_added', recordType: 'webhook_endpoint', recordId: e.id, changes: { url: u.toString(), events } });
    return { ok: true as const, id: e.id, secret };
  });
}

export async function removeEndpoint(db: Db, ctx: Ctx, id: string): Promise<{ ok: true } | Fail<'not_found'>> {
  assertPermission(ctx, 'manage_integrations');
  if (!isUuid(id)) return fail('not_found');
  return withTenant(db, ctx.tenantId, async (tx) => {
    const gone = await tx.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id)).returning({ url: webhookEndpoints.url });
    if (!gone.length) return fail('not_found');
    await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'webhook_removed', recordType: 'webhook_endpoint', recordId: id, changes: { url: gone[0].url } });
    return { ok: true as const };
  });
}

/**
 * Cron: sends due deliveries across shops. The host is resolved and every address checked just before sending (DNS can change after the URL was saved).
 * Redirects are not followed. Failures retry with backoff, then stop after 8 attempts.
 */
export async function runWebhookDeliveries(db: Db, now: Date, opts: { resolve?: Resolver; post?: Poster; batch?: number } = {}): Promise<{ delivered: number; failed: number }> {
  const resolve = opts.resolve ?? liveResolver;
  const post = opts.post ?? livePoster;
  const due = await asPlatform(db, (tx) => tx.select({ d: webhookDeliveries, url: webhookEndpoints.url, secretSealed: webhookEndpoints.secretSealed, active: webhookEndpoints.active })
    .from(webhookDeliveries).innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, now))).orderBy(asc(webhookDeliveries.nextAttemptAt)).limit(opts.batch ?? 50));
  let delivered = 0;
  let failed = 0;
  for (const { d, url, secretSealed, active } of due) {
    let error: string | null = null;
    const secret = openSecret(secretSealed);
    const u = checkEndpointUrl(url);
    if (!active || !secret || !u) error = 'endpoint disabled or invalid';
    else {
      try {
        const addresses = await resolve(u.hostname);
        if (!addresses.length || addresses.some(privateAddress)) error = 'host resolves to a private address';
        else {
          const timestamp = String(Math.floor(now.getTime() / 1000));
          const body = JSON.stringify({ id: d.id, event: d.event, createdAt: d.createdAt.toISOString(), data: d.payload });
          const r = await post(u.toString(), { body, headers: { 'content-type': 'application/json', 'x-webhook-id': d.id, 'x-webhook-timestamp': timestamp, 'x-webhook-signature': signDelivery(secret, timestamp, body) } });
          if (!r.ok) error = `HTTP ${r.status}`;
        }
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 200) : 'request failed';
      }
    }
    const attempts = d.attempts + 1;
    await asPlatform(db, (tx) => tx.update(webhookDeliveries).set(error === null
      ? { status: 'delivered', attempts, deliveredAt: now, lastError: null }
      : { status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts, lastError: error, nextAttemptAt: new Date(now.getTime() + backoffMinutes(attempts) * 60_000) })
      .where(eq(webhookDeliveries.id, d.id)));
    if (error === null) delivered++; else failed++;
  }
  return { delivered, failed };
}
