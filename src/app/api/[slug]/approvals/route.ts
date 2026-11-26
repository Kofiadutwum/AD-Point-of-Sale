import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import { SESSION_COOKIE } from '@/lib/cookies';
import { type ApprovalAction, requestApproval } from '@/server/approvals';
import { AccessError, requireContext } from '@/server/context';

/** A till asks for another person's approval by PIN (spec 6.7), e.g. a pharmacist for prescription-only medicine (6.36). Online only. */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const now = new Date();
  let ctx;
  try {
    ctx = await requireContext(getDb(), { slug, sessionToken: (await cookies()).get(SESSION_COOKIE)?.value, permission: 'make_sale' }, now);
  } catch (e) {
    if (!(e instanceof AccessError)) throw e;
    return Response.json({ ok: false, error: e.code }, { status: e.code === 'not_signed_in' || e.code === 'wrong_shop' ? 401 : 403 });
  }
  const body = (await request.json().catch(() => null)) as { action?: ApprovalAction; contextKey?: string; approverId?: string; pin?: string } | null;
  const r = await requestApproval(getDb(), ctx, {
    action: body?.action as ApprovalAction, contextKey: String(body?.contextKey ?? ''), approverId: String(body?.approverId ?? ''), pin: String(body?.pin ?? ''),
  }, now);
  return Response.json(r, { status: r.ok ? 200 : 400 });
}
