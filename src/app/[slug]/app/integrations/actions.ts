'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { createApiKey, revokeApiKey } from '@/server/api-keys';
import { addDomain, removeDomain, verifyDomain } from '@/server/domains';
import { saveShopPaystackKey } from '@/server/shop-paystack';
import { addEndpoint, removeEndpoint } from '@/server/webhooks';
import { pageCtx } from '../page-ctx';

const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();
const done = (slug: string, message: string, copy?: string): FormState => { revalidatePath(`/${slug}/app/integrations`); return { error: null, message, copy: copy ?? null }; };

export async function savePaystackAction(slug: string, remove: boolean, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_integrations');
  const r = await saveShopPaystackKey(getDb(), ctx, remove ? null : text(fd, 'key'));
  if (!r.ok) return { error: 'That is not a Paystack secret key. It starts with sk_live_ or sk_test_.' };
  return done(slug, remove ? 'Paystack disconnected.' : 'Paystack connected. Add the webhook address below in your Paystack dashboard.');
}

export async function createKeyAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_integrations');
  const r = await createApiKey(getDb(), ctx, { name: text(fd, 'name'), scopes: fd.getAll('scopes').map(String) });
  if (!r.ok) return { error: r.error === 'limit_reached' ? 'You have 10 keys. Revoke one first.' : 'Give the key a name and at least one permission.' };
  return done(slug, 'Copy this key now. It will not be shown again.', r.key);
}

export async function revokeKeyAction(slug: string, id: string): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_integrations');
  await revokeApiKey(getDb(), ctx, id, new Date());
  return done(slug, 'Key revoked.');
}

export async function addWebhookAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_integrations');
  const r = await addEndpoint(getDb(), ctx, { url: text(fd, 'url'), events: fd.getAll('events').map(String) });
  if (!r.ok) return { error: r.error === 'invalid_url' ? 'Use a public https:// address.' : r.error === 'limit_reached' ? 'You have 5 webhooks. Remove one first.' : 'Choose at least one event.' };
  return done(slug, 'Webhook added. Copy its signing secret now; it will not be shown again.', r.secret);
}

export async function removeWebhookAction(slug: string, id: string): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_integrations');
  await removeEndpoint(getDb(), ctx, id);
  return done(slug, 'Webhook removed.');
}

export async function addDomainAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_integrations');
  const r = await addDomain(getDb(), ctx, text(fd, 'host'));
  if (!r.ok) return { error: r.error === 'taken' ? 'Another shop already uses that domain.' : r.error === 'limit_reached' ? 'A shop can have 3 domains.' : 'Enter a domain like shop.example.com.' };
  return done(slug, 'Domain added. Create the DNS records shown, then press Check.');
}

export async function verifyDomainAction(slug: string, id: string): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_integrations');
  const r = await verifyDomain(getDb(), ctx, id, new Date());
  if (!r.ok) return { error: 'The TXT record was not found yet. DNS changes can take up to an hour.' };
  return done(slug, 'Domain verified. It now opens your shop.');
}

export async function removeDomainAction(slug: string, id: string): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_integrations');
  await removeDomain(getDb(), ctx, id);
  return done(slug, 'Domain removed.');
}
