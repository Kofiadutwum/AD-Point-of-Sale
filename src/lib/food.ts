import { toMilli } from './decimal';

/** Food rules shared by the server and the till (spec 6.51, 6.56, 6.58). */
export type ServiceMode = 'counter' | 'table' | 'quick';
export type DiningOption = 'eat_in' | 'takeaway' | 'delivery';
export const SERVICE_MODES: readonly ServiceMode[] = ['counter', 'table', 'quick'];
export const DINING_OPTIONS = ['eat_in', 'takeaway', 'delivery'] as const satisfies readonly DiningOption[];

/** Online '047'; offline the register code first, 'T2-047', so two tills never print the same number. */
export const ORDER_NUMBER = /^(?:[A-Z0-9]{1,6}-)?\d{3}$/;

export function formatOrderNumber(counter: number): string {
  return String(((counter - 1) % 999) + 1).padStart(3, '0');
}

export function offlineOrderNumber(registerCode: string, counter: number): string {
  return `${registerCode}-${formatOrderNumber(counter)}`;
}

/** How many packs a cart owes; 0 for eat in, with no pack item set, or when nothing but the pack is in the cart. */
export function packCount(
  lines: Array<{ variantId: string; quantity: string }>,
  opts: { diningOption: DiningOption; mode: 'per_item' | 'per_order'; needsPack: (variantId: string) => boolean; packVariantId: string | null },
): number {
  if (opts.diningOption === 'eat_in' || !opts.packVariantId) return 0;
  const items = lines.filter((l) => l.variantId !== opts.packVariantId);
  if (opts.mode === 'per_order') return items.length > 0 ? 1 : 0;
  const milli = items.filter((l) => opts.needsPack(l.variantId)).reduce((sum, l) => sum + toMilli(l.quantity), 0n);
  return Number((milli + 999n) / 1000n); // part units round up to a whole pack
}

export function needsPacking(diningOption: DiningOption): boolean {
  return diningOption !== 'eat_in';
}
