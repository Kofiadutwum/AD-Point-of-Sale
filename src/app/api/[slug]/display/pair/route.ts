import { getDb } from '@/db/client';
import { pairDisplay } from '@/server/customer-display';

/** Spec 6.50: the display enters the code shown on the till and gets its read-only token. */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = await request.json().catch(() => undefined) as { code?: unknown } | undefined;
  const r = await pairDisplay(getDb(), slug, String(body?.code ?? ''), new Date());
  return Response.json(r, { status: r.ok ? 200 : 400, headers: { 'Cache-Control': 'no-store' } });
}
