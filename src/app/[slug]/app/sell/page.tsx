import { cookies } from 'next/headers';
import { SellScreen } from '@/components/till/sell-screen';
import { getDb } from '@/db/client';
import { DEVICE_COOKIE } from '@/lib/cookies';
import { tillRegister, tillTaxMode } from '@/server/till';
import { pageCtx } from '../page-ctx';

/** The online sell screen. The offline-first till is Plan 4's /[slug]/till/sell; both post to /api/[slug]/sales. */
export default async function SellPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'make_sale');
  const till = await tillRegister(getDb(), ctx, (await cookies()).get(DEVICE_COOKIE)?.value);
  if (!till) {
    return <main className="p-2">This device is not a till. Sign in with your PIN on a registered till. <a className="text-blue-800 underline" href={`/${slug}/app`}>Home</a></main>;
  }
  return (
    <SellScreen slug={slug} till={till} canDiscount={ctx.permissions.includes('give_discount')}
      taxMode={await tillTaxMode(getDb(), ctx)} />
  );
}

