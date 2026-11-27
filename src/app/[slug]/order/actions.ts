'use server';
import { cookies, headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { getImageStore } from '@/server/image-store';
import { orderAwaitingPaystack, type PlaceInput, placeOnlineOrder, requestPhoneCode, uploadProof, verifyPhoneCode } from '@/server/online-orders';
import { clientIp } from '@/server/rate-limit';
import { startOrderCharge } from '@/server/shop-paystack';
import { orderTokenCookie } from './token';

export async function requestCodeAction(slug: string, phone: string): Promise<{ ok: true; verificationId: string } | { ok: false; error: string }> {
  const r = await requestPhoneCode(getDb(), slug, phone, new Date());
  if (r.ok) return r;
  return { ok: false, error: r.error === 'invalid_phone' ? 'Enter a Ghana phone number.' : r.error === 'too_many' ? 'Too many codes. Try again in an hour.' : 'This shop is not taking online orders.' };
}

export async function verifyCodeAction(slug: string, verificationId: string, code: string): Promise<{ ok: true; phone: string } | { ok: false; error: string }> {
  const r = await verifyPhoneCode(getDb(), slug, verificationId, code, new Date());
  if (!r.ok) return { ok: false, error: r.error === 'wrong_code' ? 'That code is wrong.' : 'The code has expired. Ask for a new one.' };
  (await cookies()).set(orderTokenCookie(slug), r.token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 180 * 86_400 });
  return { ok: true, phone: r.phone };
}

const PLACE_ERRORS: Record<string, string> = {
  closed: 'This shop is not taking online orders.', phone_not_verified: 'Confirm your phone number first.', invalid_input: 'Check your order details.',
  too_many: 'Too many orders from this phone. Try again later.', unavailable: 'Some items are no longer available. Refresh and try again.', payment_unavailable: 'That way to pay is not available.',
};

export async function placeOrderAction(slug: string, input: Omit<PlaceInput, 'token'>): Promise<{ ok: true; next: string } | { ok: false; error: string }> {
  const token = (await cookies()).get(orderTokenCookie(slug))?.value;
  const r = await placeOnlineOrder(getDb(), slug, { ...input, token }, clientIp(await headers()), new Date());
  if (!r.ok) return { ok: false, error: PLACE_ERRORS[r.error] ?? 'Something went wrong.' };
  if (input.payMethod === 'paystack') {
    const url = await startOrderCharge(getDb(), r.tenantId, slug, { id: r.orderId, number: r.number, totalPesewas: r.totalPesewas });
    if (url) return { ok: true, next: url };
  }
  return { ok: true, next: `/${slug}/order/${r.orderId}` };
}

export async function uploadProofAction(slug: string, orderId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const file = fd.get('proof');
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose the screenshot of your transfer.' };
  const token = (await cookies()).get(orderTokenCookie(slug))?.value;
  const r = await uploadProof(getDb(), getImageStore(), slug, orderId, token, new Uint8Array(await file.arrayBuffer()), new Date());
  if (!r.ok) return { error: r.error === 'bad_image' ? 'Use a JPG, PNG or WebP picture under 10 MB.' : 'This order is not waiting for payment.' };
  revalidatePath(`/${slug}/order/${orderId}`);
  return { error: null, message: 'Thank you. The shop will confirm once the money arrives.' };
}

/** Opens a new Paystack checkout for the visitor's unpaid order (the first one failed to open). */
export async function payAgainAction(slug: string, orderId: string): Promise<FormState> {
  const token = (await cookies()).get(orderTokenCookie(slug))?.value;
  const o = await orderAwaitingPaystack(getDb(), slug, orderId, token, new Date());
  if (!o) return { error: 'This order cannot be paid now.' };
  const url = await startOrderCharge(getDb(), o.tenantId, slug, o);
  if (!url) return { error: 'Paystack is not answering. Try again in a minute.' };
  redirect(url);
}

/** The transfer screenshot, already compressed on the phone (PhotoUpload sends it as "photo"). */
export async function uploadProofPhotoAction(slug: string, orderId: string, fd: FormData): Promise<{ error: string | null; message?: string | null }> {
  const proof = new FormData();
  const photo = fd.get('photo');
  if (photo) proof.set('proof', photo);
  const r = await uploadProofAction(slug, orderId, { error: null }, proof);
  return { error: r.error, message: r.message ?? null };
}
