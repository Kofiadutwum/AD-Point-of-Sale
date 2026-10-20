'use server';
import { redirect } from 'next/navigation';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { createProduct } from '@/server/products';
import { pageCtx } from '../../page-ctx';
import { catalogueMessage, cedis, kindOf, optionalNumber, readProductFields, ticked, value } from '../form-data';

export async function createProductAction(slug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_products');
  const r = await createProduct(getDb(), ctx, {
    ...readProductFields(formData),
    kind: kindOf(formData), baseUnit: value(formData, 'baseUnit'), allowsFractions: ticked(formData, 'allowsFractions'),
    variants: [{
      sku: value(formData, 'sku'), barcodes: value(formData, 'barcodes').split(/\s+/).filter(Boolean),
      basePricePesewas: cedis(formData, 'price'), costPesewas: cedis(formData, 'cost'),
      reorderLevel: value(formData, 'reorderLevel'), scaleItemCode: optionalNumber(formData, 'scaleItemCode'),
    }],
  });
  if (!r.ok) return { error: catalogueMessage(r.error, r.detail) };
  redirect(`/${slug}/app/products/${r.productId}`);
}
