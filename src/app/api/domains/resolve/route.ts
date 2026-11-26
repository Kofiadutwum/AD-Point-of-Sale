import { getDb } from '@/db/client';
import { slugForHost } from '@/server/domains';

/** The proxy maps a subdomain or custom domain to a shop through this route; internal callers only (shared secret). */
export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get('x-internal') !== process.env.CRON_SECRET) return new Response(null, { status: 404 });
  const host = new URL(request.url).searchParams.get('host') ?? '';
  return Response.json({ slug: await slugForHost(getDb(), host) }, { headers: { 'cache-control': 'no-store' } });
}
