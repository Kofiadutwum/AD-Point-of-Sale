import { getDb } from '@/db/client';
import { orderLink } from '@/server/storefront';

const appUrl = () => process.env.APP_URL ?? 'http://localhost:3000';

/** Spec 6.19: counts a WhatsApp or call click, then sends the visitor on; the platform stores no messages. */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string; kind: string }> }) {
  const { slug, kind } = await params;
  if (kind !== 'whatsapp' && kind !== 'call') return new Response('Not found', { status: 404 });
  const productId = new URL(request.url).searchParams.get('product');
  const productUrl = productId ? `${appUrl()}/${slug}/p/${productId}` : `${appUrl()}/${slug}`;
  const to = await orderLink(getDb(), slug, kind, productId, productUrl, new Date());
  if (!to) return new Response('Not found', { status: 404 });
  return new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store' } });
}
