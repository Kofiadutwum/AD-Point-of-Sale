import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import { SESSION_COOKIE } from '@/lib/cookies';
import { AccessError, requireContext } from '@/server/context';
import { getImageStore } from '@/server/image-store';
import { orderProof } from '@/server/online-orders';

const notFound = () => new Response('Not found', { status: 404 });

/** The customer's transfer screenshot, for staff who handle online orders only. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const db = getDb();
  let ctx;
  try {
    ctx = await requireContext(db, { slug, sessionToken: (await cookies()).get(SESSION_COOKIE)?.value, permission: 'online_orders' }, new Date());
  } catch (e) {
    if (e instanceof AccessError) return notFound();
    throw e;
  }
  const bytes = await orderProof(db, getImageStore(), ctx, id);
  if (!bytes) return notFound();
  return new Response(new Blob([new Uint8Array(bytes)], { type: 'image/webp' }), { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store' } });
}
