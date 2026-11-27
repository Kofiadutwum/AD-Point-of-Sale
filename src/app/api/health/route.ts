import { getDb } from '@/db/client';
import { health } from '@/server/health';

export const dynamic = 'force-dynamic';

/** Phase 8: GET /api/health answers 200 when the database is up and fully migrated, else 503 (for an uptime monitor). */
export async function GET() {
  const h = await health(getDb(), new Date());
  return Response.json(h, { status: h.ok ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}
