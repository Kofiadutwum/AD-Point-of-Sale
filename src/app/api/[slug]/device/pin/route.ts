import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import { cookieOptions, DEVICE_COOKIE, SESSION_COOKIE } from '@/lib/cookies';
import { deviceFor } from '@/server/device-cache';
import { switchCashierWithPin } from '@/server/devices';

/** Online PIN switch for the selling screen. A refusal is 200 { ok: false }, so the device only falls back offline on network errors. */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = await request.json().catch(() => null) as { staffId?: unknown; pin?: unknown } | null;
  if (!body || typeof body.staffId !== 'string' || typeof body.pin !== 'string') return Response.json({ ok: false, error: 'invalid_input' }, { status: 400 });
  const jar = await cookies();
  const deviceToken = jar.get(DEVICE_COOKIE)?.value;
  const db = getDb();
  if (!(await deviceFor(db, { deviceToken, slug }))) return Response.json({ ok: false, error: 'device_not_registered' });
  const r = await switchCashierWithPin(db, { deviceToken, staffId: body.staffId, pin: body.pin }, new Date());
  if (!r.ok) return Response.json({ ok: false, error: r.error });
  jar.set(SESSION_COOKIE, r.token, cookieOptions(r.expiresAt));
  return Response.json({ ok: true, staffId: body.staffId });
}
