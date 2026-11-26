import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import { SESSION_COOKIE } from '@/lib/cookies';
import { AccessError, requireContext } from '@/server/context';
import { pushCart } from '@/server/customer-display';

/** Spec 6.50: the till sends its current cart for its paired display (null after the sale). */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = getDb();
  try {
    const ctx = await requireContext(db, { slug, sessionToken: (await cookies()).get(SESSION_COOKIE)?.value, permission: 'make_sale' }, new Date());
    const body = await request.json().catch(() => undefined) as { cart?: unknown } | undefined;
    const r = await pushCart(db, ctx, (body?.cart ?? null) as never, new Date());
    return Response.json(r, { status: r.ok ? 200 : 400 });
  } catch (e) {
    if (e instanceof AccessError) return new Response(null, { status: 401 });
    throw e;
  }
}
