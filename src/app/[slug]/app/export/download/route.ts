import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import { SESSION_COOKIE } from '@/lib/cookies';
import { AccessError, requireContext } from '@/server/context';
import { exportData } from '@/server/data-export';

/** One dataset as a CSV download (spec 4.29, 6.46); sign-in required, works during read-only expiry. */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = getDb();
  let ctx;
  try {
    ctx = await requireContext(db, { slug, sessionToken: (await cookies()).get(SESSION_COOKIE)?.value, permission: 'export_data', allowReadOnly: true }, new Date());
  } catch (e) {
    if (e instanceof AccessError) return new Response('Not found', { status: 404 });
    throw e;
  }
  const q = new URL(request.url).searchParams;
  const r = await exportData(db, ctx, q.get('dataset') ?? '', { from: q.get('from') ?? undefined, to: q.get('to') ?? undefined });
  if (!r.ok) return new Response(r.error === 'range_too_long' ? 'Pick at most 366 days.' : 'Choose the data and the dates.', { status: 400 });
  return new Response(r.csv, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'private, no-store', 'Content-Disposition': `attachment; filename="${r.filename}"` },
  });
}
