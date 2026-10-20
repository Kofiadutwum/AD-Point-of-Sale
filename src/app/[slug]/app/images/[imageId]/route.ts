import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import { SESSION_COOKIE } from '@/lib/cookies';
import { AccessError, requireContext } from '@/server/context';
import { getImageStore } from '@/server/image-store';
import { readProductImage } from '@/server/product-images';

const notFound = () => new Response('Not found', { status: 404 });

/** A product photo for signed-in staff of this shop; anyone else gets 404. Keys never change, so it caches for a year. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string; imageId: string }> }) {
  const { slug, imageId } = await params;
  const db = getDb();
  let ctx;
  try {
    ctx = await requireContext(db, { slug, sessionToken: (await cookies()).get(SESSION_COOKIE)?.value, permission: null }, new Date());
  } catch (e) {
    if (e instanceof AccessError) return notFound();
    throw e;
  }
  const bytes = await readProductImage(db, getImageStore(), ctx, imageId);
  if (!bytes) return notFound();
  return new Response(new Blob([new Uint8Array(bytes)], { type: 'image/webp' }), {
    headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=31536000, immutable' },
  });
}
