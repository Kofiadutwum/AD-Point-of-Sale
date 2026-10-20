import { divHalfUp, toMilli } from './decimal';

// Unit costs are pesewas per base unit with 4 decimal places ('416.6667'), as variants.average_cost stores them.

const COST_SCALE = 10_000n;

function toCost(value: string): bigint {
  const [whole, frac = ''] = value.split('.');
  return BigInt(whole) * COST_SCALE + BigInt(frac.padEnd(4, '0').slice(0, 4));
}

const fromCost = (n: bigint) => `${n / COST_SCALE}.${(n % COST_SCALE).toString().padStart(4, '0')}`;

/** total_cost / base_qty to 4 places, half up (spec 6.23); baseQty > 0. */
export function unitCostOf(totalCostPesewas: number, baseQty: string): string {
  return fromCost(divHalfUp(BigInt(totalCostPesewas) * COST_SCALE * 1000n, toMilli(baseQty)));
}

/** Spec 6.23 weighted average; with nothing (or less than nothing) on hand, the new stock's cost. onHand may be negative. */
export function weightedAverageCost(onHand: string, averageCost: string, addedQty: string, addedUnitCost: string): string {
  if (onHand.startsWith('-') || toMilli(onHand) === 0n) return fromCost(toCost(addedUnitCost));
  const held = toMilli(onHand);
  const added = toMilli(addedQty);
  return fromCost(divHalfUp(held * toCost(averageCost) + added * toCost(addedUnitCost), held + added));
}
