import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import { DEVICE_COOKIE } from '@/lib/cookies';
import { reportHeldSale } from '@/server/held-sales';

/** A till reports an offline sale the server refused (or one that later synced), for the manager's review list. */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const report = await request.json().catch(() => null);
  const r = await reportHeldSale(getDb(), { deviceToken: (await cookies()).get(DEVICE_COOKIE)?.value, slug, report }, new Date());
  if (!r.ok) return Response.json(r, { status: r.error === 'device_not_registered' ? 401 : 400 });
  return Response.json(r);
}
