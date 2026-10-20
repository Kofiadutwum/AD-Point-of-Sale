import 'server-only';
import type { Db } from '@/db/client';
import { DEVICE_COOKIE, SESSION_COOKIE } from '@/lib/cookies';
import { AccessError, type Ctx, requireContext } from './context';
import { findDeviceRegister } from './devices';
import { completeSale, type SaleInput } from './sales';
import { registerById, tillRegister } from './till';

// The sale contract shared with the offline outbox (Plan 4): 200 ok, 400 invalid input, 401/403 access, 409 business errors.

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

async function context(db: Db, request: Request, slug: string, permission: 'make_sale' | null, now: Date): Promise<Ctx | Response> {
  try {
    return await requireContext(db, { slug, sessionToken: cookie(request, SESSION_COOKIE), permission }, now);
  } catch (e) {
    if (!(e instanceof AccessError)) throw e;
    return json({ ok: false, error: e.code }, e.code === 'not_signed_in' || e.code === 'wrong_shop' ? 401 : 403);
  }
}

export async function handleSalePost(db: Db, request: Request, slug: string, now: Date): Promise<Response> {
  const ctx = await context(db, request, slug, 'make_sale', now);
  if (ctx instanceof Response) return ctx;
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ ok: false, error: 'invalid_input' }, 400);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_input' }, 400);
  }
  const till = await tillRegister(db, ctx, cookie(request, DEVICE_COOKIE));
  const result = await completeSale(db, { ...ctx, registerId: till?.registerId ?? null }, body as SaleInput, now);
  return json(result, result.ok ? 200 : result.error === 'invalid_input' ? 400 : 409);
}

/** The device restores its receipt counter after a reinstall, before anyone signs in, so the device cookie alone is enough. */
export async function handleCounterGet(db: Db, request: Request, slug: string, now: Date): Promise<Response> {
  const device = await findDeviceRegister(db, cookie(request, DEVICE_COOKIE));
  if (device && device.slug === slug) {
    const till = await registerById(db, device.tenantId, device.registerId);
    if (till) return json({ registerCode: till.registerCode, lastCounter: till.lastCounter }, 200);
  }
  if (!cookie(request, SESSION_COOKIE)) return json({ error: 'not_signed_in' }, 401);
  const ctx = await context(db, request, slug, null, now);
  if (ctx instanceof Response) return ctx;
  const till = await tillRegister(db, ctx, undefined);
  return till ? json({ registerCode: till.registerCode, lastCounter: till.lastCounter }, 200) : json({ error: 'no_register' }, 409);
}
