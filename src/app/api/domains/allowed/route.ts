import { getDb } from '@/db/client';
import { slugForHost } from '@/server/domains';

/** On-demand TLS check (e.g. Caddy "ask"): 200 only for hosts that belong to an active shop, so certificates are not issued for strangers. */
export async function GET(request: Request) {
  const domain = new URL(request.url).searchParams.get('domain') ?? '';
  return new Response(null, { status: (await slugForHost(getDb(), domain)) ? 200 : 404 });
}
