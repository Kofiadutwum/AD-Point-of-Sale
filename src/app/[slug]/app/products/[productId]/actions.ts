'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { setProductStatus, updateProduct } from '@/server/products';
import {
  addBarcode, addComponent, addUnit, addVariant, removeBarcode, removeComponent, removeUnit, setVariantStatus, updateUnit, updateVariant,
} from '@/server/variants';
import { removePriceListItem, setPriceListItem } from '@/server/price-lists';
import { getImageStore } from '@/server/image-store';
import { makeMainImage, removeProductImage, uploadProductImage } from '@/server/product-images';
import { setItemAddOnGroups } from '@/server/add-ons';
import { getComboSlots, saveComboSlots } from '@/server/combos';
import { pageCtx } from '../../page-ctx';
import { catalogueMessage, cedis, optionalNumber, readProductFields, readUnitFields, readVariantFields, value } from '../form-data';

const ADD_ON_LINK_MESSAGES: Record<string, string> = {
  invalid_input: 'Pick up to 10 groups.', unknown_item: 'That item or group no longer exists.',
  not_allowed: 'Combos and sell-by-amount items have no add-ons.', module_off: 'Turn on the kitchen module first.',
};

/** Spec 4.24: the add-on groups this item offers, in the order of the add-ons list. */
export async function setItemAddOnsAction(slug: string, productId: string, variantId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_products');
  const r = await setItemAddOnGroups(getDb(), ctx, variantId, formData.getAll('groupId').map(String));
  if (!r.ok) return { error: ADD_ON_LINK_MESSAGES[r.error] ?? 'Something went wrong. Try again.' };
  revalidatePath(`/${slug}/app/products/${productId}`);
  return { error: null, message: 'Add-ons saved.' };
}

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

const PHOTO_MESSAGES: Record<string, string> = {
  image_limit_reached: 'A product can have up to 5 photos.',
  too_large: 'Photo is too large. Choose one under 10 MB.',
  unsupported_type: 'Choose a JPEG, PNG, or WebP photo.',
  heic_not_supported: 'iPhone HEIC photos are not supported. Choose the photo again from Photos, or set Settings › Camera › Formats to Most Compatible.',
  could_not_read: 'This file could not be read as a photo.',
  could_not_compress: 'Photo too detailed. Try a closer or plainer photo.',
};

/** Called by PhotoUpload with the photo the device already compressed; the server re-compresses it regardless. */
export async function uploadPhotoAction(slug: string, productId: string, fd: FormData): Promise<FormState> {
  const photo = fd.get('photo');
  if (!(photo instanceof Blob)) return { error: 'Choose a photo' };
  const bytes = new Uint8Array(await photo.arrayBuffer());
  return run(slug, productId, 'Photo added.', (ctx) => uploadProductImage(getDb(), getImageStore(), ctx, productId, bytes), PHOTO_MESSAGES);
}

export async function makeMainPhotoAction(slug: string, productId: string, imageId: string, _prev: FormState, _fd: FormData): Promise<FormState> {
  return run(slug, productId, 'Main photo set.', (ctx) => makeMainImage(getDb(), ctx, imageId));
}

export async function removePhotoAction(slug: string, productId: string, imageId: string, _prev: FormState, _fd: FormData): Promise<FormState> {
  return run(slug, productId, 'Photo removed.', (ctx) => removeProductImage(getDb(), getImageStore(), ctx, imageId));
}

const COMBO_MESSAGES: Record<string, string> = {
  invalid_input: 'Give the slot a name, pick at least one item, and keep the minimum at or below the maximum.',
  not_a_combo: 'Only combo meals have choice slots.', unknown_item: 'Pick active items from this shop.', nested_combo: 'A combo cannot be a choice in another combo.',
};

export async function addComboSlotAction(slug: string, productId: string, variantId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return run(slug, productId, 'Slot added.', async (ctx) => {
    const current = await getComboSlots(getDb(), ctx, variantId);
    const choices = fd.getAll('choice').map(String).map((id) => ({ variantId: id, upgradePesewas: value(fd, `upgrade-${id}`) ? cedis(fd, `upgrade-${id}`) : 0 }));
    const slot = { name: value(fd, 'slotName'), minChoices: optionalNumber(fd, 'minChoices') ?? 1, maxChoices: optionalNumber(fd, 'maxChoices') ?? 1, choices };
    return saveComboSlots(getDb(), ctx, variantId, [...current.map(({ name, minChoices, maxChoices, choices: c }) => ({ name, minChoices, maxChoices, choices: c })), slot]);
  }, COMBO_MESSAGES);
}

export async function removeComboSlotAction(slug: string, productId: string, variantId: string, slotId: string, _prev: FormState, _fd: FormData): Promise<FormState> {
  return run(slug, productId, 'Slot removed.', async (ctx) => {
    const rest = (await getComboSlots(getDb(), ctx, variantId)).filter((s) => s.id !== slotId);
    if (rest.length === 0) return { ok: false, error: 'last_slot' };
    return saveComboSlots(getDb(), ctx, variantId, rest.map(({ name, minChoices, maxChoices, choices }) => ({ name, minChoices, maxChoices, choices })));
  }, { ...COMBO_MESSAGES, last_slot: 'A combo keeps at least one slot. Add the new slot first, then remove this one.' });
}
