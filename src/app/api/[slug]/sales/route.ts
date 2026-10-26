import { getDb } from '@/db/client';
import { handleSalePost } from '@/server/sales-http';

/** Spec 6.8 for tills and the offline outbox (6.10); the contract is in src/server/sales-http.ts. */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  return handleSalePost(getDb(), request, (await params).slug, new Date());
}
