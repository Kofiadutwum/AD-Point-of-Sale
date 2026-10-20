'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { setProductStatus, updateProduct } from '@/server/products';
import {
  addBarcode, addComponent, addUnit, addVariant, removeBarcode, removeComponent, removeUnit, setVariantStatus, updateUnit, updateVariant,
} from '@/server/variants';
import { removePriceListItem, setPriceListItem } from '@/server/price-lists';
import { pageCtx } from '../../page-ctx';
import { catalogueMessage, cedis, optionalNumber, readProductFields, readUnitFields, readVariantFields, value } from '../form-data';

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

type Result = { ok: true } | { ok: false; error: string; detail?: string };

/** Runs a catalogue change for this product page and turns its result into form state. */
async function run(slug: string, productId: string, message: string, change: (ctx: Awaited<ReturnType<typeof pageCtx>>) => Promise<Result>,
  messages: Record<string, string> = {}): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_products');
  const r = await change(ctx);
  if (!r.ok) return { error: messages[r.error] ?? catalogueMessage(r.error, r.detail) };
  revalidatePath(`/${slug}/app/products/${productId}`);
  return { error: null, message };
}

const UNIT_MESSAGES = { duplicate_name: 'This item already has a unit with that name.' };

export async function addVariantAction(slug: string, productId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return run(slug, productId, 'Variant added.', (ctx) => addVariant(getDb(), ctx, productId, {
    name: value(fd, 'name'), sku: value(fd, 'sku'), barcodes: value(fd, 'barcodes').split(/\s+/).filter(Boolean),
    basePricePesewas: cedis(fd, 'price'), costPesewas: cedis(fd, 'cost'), scaleItemCode: optionalNumber(fd, 'scaleItemCode'),
  }));
}

export async function updateVariantAction(slug: string, productId: string, variantId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return run(slug, productId, 'Saved.', (ctx) => updateVariant(getDb(), ctx, variantId, readVariantFields(fd)));
}

export async function setVariantStatusAction(
  slug: string, productId: string, variantId: string, status: 'active' | 'archived', _prev: FormState, _fd: FormData,
): Promise<FormState> {
  return run(slug, productId, status === 'archived' ? 'Archived.' : 'Restored.', (ctx) => setVariantStatus(getDb(), ctx, variantId, status));
}

export async function addUnitAction(slug: string, productId: string, variantId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return run(slug, productId, 'Unit added.', (ctx) => addUnit(getDb(), ctx, variantId, readUnitFields(fd)), UNIT_MESSAGES);
}

export async function updateUnitAction(slug: string, productId: string, unitId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return run(slug, productId, 'Saved.', (ctx) => updateUnit(getDb(), ctx, unitId, readUnitFields(fd)), UNIT_MESSAGES);
}

export async function removeUnitAction(slug: string, productId: string, unitId: string, _prev: FormState, _fd: FormData): Promise<FormState> {
  return run(slug, productId, 'Unit removed.', (ctx) => removeUnit(getDb(), ctx, unitId));
}

export async function addBarcodeAction(slug: string, productId: string, unitId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return run(slug, productId, 'Barcode added.', (ctx) => addBarcode(getDb(), ctx, unitId, value(fd, 'code')));
}

export async function removeBarcodeAction(slug: string, productId: string, barcodeId: string, _prev: FormState, _fd: FormData): Promise<FormState> {
  return run(slug, productId, 'Barcode removed.', (ctx) => removeBarcode(getDb(), ctx, barcodeId));
}

export async function addComponentAction(slug: string, productId: string, variantId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return run(slug, productId, 'Part added.', (ctx) => addComponent(getDb(), ctx, variantId, { code: value(fd, 'code'), quantity: value(fd, 'quantity') }));
}

export async function removeComponentAction(slug: string, productId: string, componentId: string, _prev: FormState, _fd: FormData): Promise<FormState> {
  return run(slug, productId, 'Part removed.', (ctx) => removeComponent(getDb(), ctx, componentId));
}

export async function setListPriceAction(slug: string, productId: string, unitId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return run(slug, productId, 'List price saved.', (ctx) => setPriceListItem(getDb(), ctx, {
    priceListId: value(fd, 'priceListId'), unitId, minQuantity: value(fd, 'minQuantity') || '1', pricePesewas: cedis(fd, 'price'),
  }));
}

export async function removeListPriceAction(slug: string, productId: string, itemId: string, _prev: FormState, _fd: FormData): Promise<FormState> {
  return run(slug, productId, 'List price removed.', (ctx) => removePriceListItem(getDb(), ctx, itemId));
}
