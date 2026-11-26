import { getDb } from '@/db/client';
import { apiRead, authenticateKey, RESOURCES, type Resource } from '@/server/api-keys';

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** Spec 4.29: GET /api/v1/{products|stock|sales|orders} with "Authorization: Bearer <key>"; sales need ?from=YYYY-MM-DD&to=YYYY-MM-DD (31 days at most). */
export async function GET(request: Request, { params }: { params: Promise<{ resource: string }> }) {
  const { resource } = await params;
  if (!(resource in RESOURCES)) return json(404, { error: 'not_found' });
  const auth = await authenticateKey(getDb(), request.headers.get('authorization'), new Date());
  if (!auth) return json(401, { error: 'invalid_key' });
  if (auth.limited) return json(429, { error: 'rate_limited', retryAfterSeconds: 900 });
  const scope = RESOURCES[resource as Resource];
  if (!auth.scopes.includes(scope)) return json(403, { error: 'missing_scope', scope });
  const url = new URL(request.url);
  const r = await apiRead(getDb(), auth.tenantId, resource as Resource, { from: url.searchParams.get('from'), to: url.searchParams.get('to') });
  return r.ok ? json(200, { data: r.data }) : json(400, { error: r.error });
}
