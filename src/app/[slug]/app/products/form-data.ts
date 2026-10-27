import type { Tracking, VariantKind } from '@/db/schema';
import { parseCedis } from '@/lib/money';
import type { ProductFields } from '@/server/products';
import type { UnitFields, VariantFields } from '@/server/variants';

export const value = (fd: FormData, key: string) => String(fd.get(key) ?? '');
export const ticked = (fd: FormData, key: string) => fd.get(key) === 'on';

/** Whole pesewas from a cedi amount; -1 (refused by the services) when it is not a plain amount. */
export const cedis = (fd: FormData, key: string) => parseCedis(value(fd, key)) ?? -1;

export function readProductFields(fd: FormData): ProductFields {
  const tracking = value(fd, 'tracking');
  return {
    name: value(fd, 'name'), description: value(fd, 'description'), brand: value(fd, 'brand'),
    categoryId: value(fd, 'categoryId') || null, taxRuleId: value(fd, 'taxRuleId') || null,
    tracking: (['batch', 'serial'].includes(tracking) ? tracking : 'none') as Tracking,
    showOnStorefront: ticked(fd, 'showOnStorefront'), featured: ticked(fd, 'featured'),
    // the pharmacy fields are shown only with the prescriptions module; when hidden, leave them out so the save keeps them
    pharmacy: fd.has('genericName') ? {
      genericName: value(fd, 'genericName'), strength: value(fd, 'strength'), dosageForm: value(fd, 'dosageForm'),
      registrationNumber: value(fd, 'registrationNumber'), prescriptionOnly: ticked(fd, 'prescriptionOnly'),
    } : undefined,
  };
}

export const kindOf = (fd: FormData): VariantKind => {
  const kind = value(fd, 'kind');
  return kind === 'bundle' || kind === 'recipe' ? kind : 'standard';
};

/** Optional whole number from a form field; NaN (refused) when it is not one. */
export const optionalNumber = (fd: FormData, key: string) => (value(fd, key).trim() ? Number(value(fd, key)) : undefined);

const MESSAGES: Record<string, (detail?: string) => string> = {
  limit_reached: () => 'Your plan allows no more products. Upgrade to add more.',
  duplicate_sku: (d) => `SKU ${d} is already used in this shop.`,
  duplicate_barcode: (d) => `Barcode ${d} is already used in this shop.`,
  looks_like_scale_label: (d) => `Barcode ${d} looks like one of your scale labels. Use a different code.`,
  duplicate_scale_code: (d) => `Scale item code ${d} is already used.`,
  scale_not_set_up: () => 'Set up scale labels in Settings first.',
  unknown_category: () => 'Choose a category.',
  unknown_tax_rule: () => 'Choose a tax rule.',
  duplicate_name: () => 'That name is already used.',
  not_found: () => 'This item no longer exists.',
  last_variant: () => 'Archive the product instead.',
  base_unit: () => 'The base unit cannot be removed.',
  in_use: () => 'This item already has stock or sales, so its tracking, fractions, and unit sizes cannot change.',
  contains_itself: () => 'A bundle cannot contain itself.',
  unknown_component: () => 'No item has that SKU or barcode.',
  invalid_quantity: () => 'Enter a quantity above zero; whole numbers for items sold whole.',
  not_a_bundle: () => 'Only bundles and recipes have parts.',
  duplicate_component: () => 'That item is already a part.',
};

export function catalogueMessage(error: string, detail?: string): string {
  return MESSAGES[error]?.(detail) ?? 'Check the details.';
}

/** Cost is sent only when the field changed, so an edit never rounds a fractional average cost (null = keep). */
export function readVariantFields(fd: FormData): VariantFields {
  const costChanged = value(fd, 'cost') !== value(fd, 'costShown');
  return {
    name: value(fd, 'name'), sku: value(fd, 'sku') || null, basePricePesewas: cedis(fd, 'price'),
    costPesewas: costChanged ? cedis(fd, 'cost') : null, reorderLevel: value(fd, 'reorderLevel') || null,
    // shown only while scale labels are on; when hidden, leave it out so the save keeps the code
    scaleItemCode: fd.has('scaleItemCode') ? optionalNumber(fd, 'scaleItemCode') ?? null : undefined,
    sellable: ticked(fd, 'sellable'), allowsFractions: ticked(fd, 'allowsFractions'),
    // shown only in food shops; when hidden, leave it out so the save keeps the flag
    needsPack: fd.has('needsPackShown') ? ticked(fd, 'needsPack') : undefined,
    sellByAmount: fd.has('needsPackShown') ? ticked(fd, 'sellByAmount') : undefined,
    minAmountPesewas: fd.has('needsPackShown') ? (value(fd, 'minAmount') ? cedis(fd, 'minAmount') : null) : undefined,
    valuePerPotPesewas: fd.has('needsPackShown') ? (value(fd, 'valuePerPot') ? cedis(fd, 'valuePerPot') : null) : undefined,
  };
}

export function readUnitFields(fd: FormData): UnitFields {
  return {
    name: value(fd, 'name'), factor: value(fd, 'factor'), pricePesewas: value(fd, 'price').trim() ? cedis(fd, 'price') : null,
    sellable: ticked(fd, 'sellable'), purchasable: ticked(fd, 'purchasable'),
  };
}

/** "12.50" for a whole-pesewa amount, for form defaults. */
export const cediText = (pesewas: number) => (pesewas / 100).toFixed(2);
