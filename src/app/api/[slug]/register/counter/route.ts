import { getDb } from '@/db/client';
import { handleCounterGet } from '@/server/sales-http';

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  return handleCounterGet(getDb(), request, (await params).slug, new Date());
}
