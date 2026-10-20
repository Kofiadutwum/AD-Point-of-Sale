import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { ADMIN_COOKIE } from '@/lib/cookies';
import { AccessError } from '@/server/context';
import { requirePlatformAdmin } from '@/server/platform-admin';

/** The signed-in platform admin, or a redirect to the admin sign-in page. */
export async function adminCtx(): Promise<{ adminId: string; name: string }> {
  try {
    return await requirePlatformAdmin(getDb(), (await cookies()).get(ADMIN_COOKIE)?.value, new Date());
  } catch (e) {
    if (e instanceof AccessError) redirect('/admin/login');
    throw e;
  }
}
