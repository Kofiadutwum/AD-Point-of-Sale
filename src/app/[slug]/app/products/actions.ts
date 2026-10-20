'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { addCategory } from '@/server/products';
import { pageCtx } from '../page-ctx';
import { catalogueMessage, value } from './form-data';

export async function addCategoryAction(slug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_products');
  const r = await addCategory(getDb(), ctx, value(formData, 'name'));
  if (!r.ok) return { error: catalogueMessage(r.error) };
  revalidatePath(`/${slug}/app/products`);
  return { error: null, message: 'Category added.' };
}
