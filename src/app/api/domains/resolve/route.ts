import { timingSafeEqual } from 'node:crypto';
import { getDb } from '@/db/client';
import { slugForHost } from '@/server/domains';

/** The proxy maps a subdomain or custom domain to a shop through this route; internal callers only (shared secret). */
export async function GET(request: Request) {
  const secret = Buffer.from(process.env.CRON_SECRET ?? '');
  const given = Buffer.from(request.headers.get('x-internal') ?? '');
  if (!secret.length || secret.length !== given.length || !timingSafeEqual(secret, given)) return new Response(null, { status: 404 });
  const host = new URL(request.url).searchParams.get('host') ?? '';
  return Response.json({ slug: await slugForHost(getDb(), host) }, { headers: { 'cache-control': 'no-store' } });
}
