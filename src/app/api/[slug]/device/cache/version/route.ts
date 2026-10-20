import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import { DEVICE_COOKIE } from '@/lib/cookies';
import { getDeviceCacheVersion } from '@/server/device-cache';

/** Polled every minute; a new number means the catalogue or staff changed (spec 6.10). */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const version = await getDeviceCacheVersion(getDb(), { deviceToken: (await cookies()).get(DEVICE_COOKIE)?.value, slug });
  if (version === null) return Response.json({ error: 'device_not_registered' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  return Response.json({ version }, { headers: { 'Cache-Control': 'no-store' } });
}
