'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { SESSION_COOKIE } from '@/lib/cookies';
import { signOut } from '@/server/auth';

export async function signOutAction(slug: string): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await signOut(getDb(), token);
  jar.delete(SESSION_COOKIE);
  redirect(`/${slug}/login`);
}
