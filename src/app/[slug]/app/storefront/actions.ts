'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { saveStorefront, setPublished } from '@/server/storefront';
import { pageCtx } from '../page-ctx';

export async function saveStorefrontAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_storefront');
  const text = (k: string) => String(fd.get(k) ?? '');
  const r = await saveStorefront(getDb(), ctx, {
    about: text('about'), whatsapp: text('whatsapp'), hours: text('hours'), themeColor: text('themeColor'), facebook: text('facebook'), instagram: text('instagram'),
    showPrices: fd.get('showPrices') === 'on', showStock: fd.get('showStock') === 'on', announcement: text('announcement'), announcementUntil: text('announcementUntil'),
  });
  if (!r.ok) return { error: 'Check the details: about text up to 500 characters, a Ghana WhatsApp number, links starting with https://.' };
  revalidatePath(`/${slug}/app/storefront`);
  return { error: null, message: 'Saved.' };
}

export async function publishAction(slug: string, published: boolean): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_storefront');
  const r = await setPublished(getDb(), ctx, published);
  if (!r.ok) return { error: 'Turn on "Show on storefront" for at least one product first.' };
  revalidatePath(`/${slug}/app/storefront`);
  return { error: null, message: published ? 'Your storefront is live.' : 'Your storefront is hidden.' };
}
