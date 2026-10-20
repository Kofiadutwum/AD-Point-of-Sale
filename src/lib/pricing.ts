import type { PriceListKind } from '@/db/schema';
import { toMilli } from './decimal';
import { pesewasTimesQty } from './money';

/** A price list with its items, as loaded for the till (and later cached on the device). */
export type PriceRule = {
  id: string; kind: PriceListKind; branchId: string | null; startsOn: string | null; endsOn: string | null; active: boolean;
  items: Array<{ unitId: string; minQuantity: string; pricePesewas: number }>;
};

/** Active, started, and not ended on `today` (both ends inclusive). */
const live = (l: PriceRule, today: string) => l.active && (!l.startsOn || l.startsOn <= today) && (!l.endsOn || today <= l.endsOn);

/**
 * Spec 6.21: the cart's list, the customer's list, the branch's list, then Retail. A list that is not live is skipped,
 * so an ended seasonal list falls back to the next list instead of setting prices. A branch list applies only at its branch.
 */
export function choosePriceList(
  lists: PriceRule[], pick: { cartListId: string | null; customerListId: string | null; branchId: string; today: string },
): PriceRule | null {
  const byId = (id: string | null) => (id ? lists.find((l) => l.id === id) : undefined);
  const candidates = [
    byId(pick.cartListId), byId(pick.customerListId),
    lists.find((l) => l.kind === 'branch' && l.branchId === pick.branchId), lists.find((l) => l.kind === 'retail'),
  ];
  return candidates.find((l) => l && live(l, pick.today) && (l.kind !== 'branch' || l.branchId === pick.branchId)) ?? null;
}

/** Spec 6.21: the highest quantity break that applies, else the unit's own price, else base price × factor. Whole pesewas per unit sold. */
export function resolvePrice(
  list: PriceRule | null, sell: { unitId: string; quantity: string; unitPricePesewas: number | null; unitFactor: string; basePricePesewas: number },
): number {
  const quantity = toMilli(sell.quantity);
  let best: PriceRule['items'][number] | null = null;
  for (const item of list?.items ?? []) {
    if (item.unitId !== sell.unitId || toMilli(item.minQuantity) > quantity) continue;
    if (!best || toMilli(item.minQuantity) > toMilli(best.minQuantity)) best = item;
  }
  return best?.pricePesewas ?? sell.unitPricePesewas ?? pesewasTimesQty(sell.basePricePesewas, sell.unitFactor);
}
