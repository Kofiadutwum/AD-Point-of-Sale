import { getDb } from '@/db/client';
import { handleShopWebhook } from '@/server/shop-paystack';

/** Spec 6.11: the shop's own Paystack account posts here (set in the shop's Paystack dashboard); verified with that shop's key. */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const raw = new Uint8Array(await request.arrayBuffer());
  const r = await handleShopWebhook(getDb(), slug, raw, request.headers.get('x-paystack-signature'), new Date());
  return new Response(null, { status: r.status });
}
