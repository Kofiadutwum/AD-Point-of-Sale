import { getDb } from '@/db/client';
import { displayState } from '@/server/customer-display';

/** Spec 6.50: what a paired display shows; the token travels in a header so it stays out of logs. */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await displayState(getDb(), slug, request.headers.get('x-display-token') ?? '', new Date());
  if (!s) return new Response(null, { status: 404 });
  return Response.json(s, { headers: { 'Cache-Control': 'no-store' } });
}
