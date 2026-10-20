'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { setProductStatus, updateProduct } from '@/server/products';
import { pageCtx } from '../../page-ctx';
import { catalogueMessage, readProductFields } from '../form-data';

export async function updateProductAction(slug: string, productId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_products');
  const r = await updateProduct(getDb(), ctx, productId, readProductFields(formData));
  if (!r.ok) return { error: catalogueMessage(r.error, r.detail) };
  revalidatePath(`/${slug}/app/products/${productId}`);
  return { error: null, message: 'Saved.' };
}

export async function setProductStatusAction(
  slug: string, productId: string, status: 'active' | 'archived', _prev: FormState, _formData: FormData,
): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_products');
  const r = await setProductStatus(getDb(), ctx, productId, status);
  if (!r.ok) return { error: catalogueMessage(r.error) };
  revalidatePath(`/${slug}/app/products/${productId}`);
  return { error: null, message: status === 'archived' ? 'Archived.' : 'Restored.' };
}
