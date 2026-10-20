import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import { DEVICE_COOKIE } from '@/lib/cookies';
import { readDeviceImage } from '@/server/device-cache';
import { getImageStore } from '@/server/image-store';

/** Product photos for a registered till; the service worker keeps them for offline use. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string; imageId: string }> }) {
  const { slug, imageId } = await params;
  const bytes = await readDeviceImage(getDb(), getImageStore(), { deviceToken: (await cookies()).get(DEVICE_COOKIE)?.value, slug, imageId });
  if (!bytes) return new Response('Not found', { status: 404 });
  return new Response(new Blob([new Uint8Array(bytes)], { type: 'image/webp' }), {
    headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=31536000, immutable' },
  });
}
