import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import { SESSION_COOKIE } from '@/lib/cookies';
import { AccessError, requireContext } from '@/server/context';
import { foodReportCsv } from '@/server/food-reports';
import { reportInput } from '../report-input';

/** The food report as a CSV download, for staff allowed to export (spec 6.59). */
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
  const input = reportInput({ from: q.get('from') ?? undefined, to: q.get('to') ?? undefined, branch: q.get('branch') ?? undefined, mode: q.get('mode') ?? undefined });
  const r = await foodReportCsv(db, ctx, input, new Date());
  if (!r.ok) return new Response(r.error === 'range_too_long' ? 'Pick at most 92 days.' : 'Check the dates.', { status: 400 });
  return new Response(r.csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="food-report-${input.from}-to-${input.to}.csv"`,
    },
  });
}
