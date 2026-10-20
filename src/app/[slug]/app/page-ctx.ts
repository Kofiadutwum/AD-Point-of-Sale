import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { SESSION_COOKIE } from '@/lib/cookies';
import type { Permission } from '@/lib/permissions';
import { AccessError, type Ctx, requireContext } from '@/server/context';

/** Context for a shop page or action; sends signed-out visitors to sign-in and others home. */
export async function pageCtx(slug: string, permission: Permission | null, opts: { allowReadOnly?: boolean } = {}): Promise<Ctx> {
  try {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    return await requireContext(getDb(), { slug, sessionToken: token, permission, allowReadOnly: opts.allowReadOnly }, new Date());
  } catch (e) {
    if (!(e instanceof AccessError)) throw e;
    if (e.code === 'not_signed_in' || e.code === 'wrong_shop') redirect(`/${slug}/login`);
    if (e.code === 'suspended') throw e; // the layout shows the suspended message
    redirect(`/${slug}/app`); // forbidden or read-only for this page
  }
}
