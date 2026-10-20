import type { Tracking, VariantKind } from '@/db/schema';
import { parseCedis } from '@/lib/money';
import type { ProductFields } from '@/server/products';

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
    pharmacy: {
      genericName: value(fd, 'genericName'), strength: value(fd, 'strength'), dosageForm: value(fd, 'dosageForm'),
      registrationNumber: value(fd, 'registrationNumber'), prescriptionOnly: ticked(fd, 'prescriptionOnly'),
    },
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
};

export function catalogueMessage(error: string, detail?: string): string {
  return MESSAGES[error]?.(detail) ?? 'Check the details.';
}
