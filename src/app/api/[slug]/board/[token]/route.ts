import { getDb } from '@/db/client';
import { handleBoardGet } from '@/server/ready-board';

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  return handleBoardGet(getDb(), slug, token, new Date());
}
