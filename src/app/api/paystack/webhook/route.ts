import { getDb } from '@/db/client';
import { handleWebhook } from '@/server/billing';
import { paystack } from '@/server/paystack';

/** Spec 6.11: Paystack posts subscription payment events here; the signature is checked on the raw bytes. */
export async function POST(request: Request) {
  const raw = new Uint8Array(await request.arrayBuffer());
  const r = await handleWebhook(getDb(), raw, request.headers.get('x-paystack-signature'), new Date(), paystack);
  return new Response(null, { status: r.status });
}
