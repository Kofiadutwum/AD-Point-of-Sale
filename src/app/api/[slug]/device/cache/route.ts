import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import { DEVICE_COOKIE } from '@/lib/cookies';
import { getDeviceCache } from '@/server/device-cache';

/** The till's offline cache. 401 tells a removed device to wipe its saved PINs (spec 4.9). */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cache = await getDeviceCache(getDb(), { deviceToken: (await cookies()).get(DEVICE_COOKIE)?.value, slug }, new Date());
  if (!cache) return Response.json({ error: 'device_not_registered' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  return Response.json(cache, { headers: { 'Cache-Control': 'no-store' } });
}
