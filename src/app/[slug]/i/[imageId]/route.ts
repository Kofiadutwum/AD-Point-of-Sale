import { getDb } from '@/db/client';
import { getImageStore } from '@/server/image-store';
import { publicImage } from '@/server/storefront';

/** A product photo on a live storefront; public, cached for 10 minutes so a takedown or hidden product stops showing soon. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string; imageId: string }> }) {
  const { slug, imageId } = await params;
  const bytes = await publicImage(getDb(), getImageStore(), slug, imageId, new Date());
  if (!bytes) return new Response('Not found', { status: 404 });
  return new Response(new Blob([new Uint8Array(bytes)], { type: 'image/webp' }), {
    headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=600' },
  });
}
