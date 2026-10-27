import { normaliseGhanaPhone } from './contact';
import { divHalfUp, fromMilli, toMilli } from './decimal';
import { pesewasTimesQty } from './money';

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

/** Spec 6.58: anything leaving the shop is packed and checked, and every delivery-app or phone order counts as leaving. */
export function needsPacking(diningOption: DiningOption, hasChannel = false): boolean {
  return hasChannel || diningOption !== 'eat_in';
}

export type ComboSlotDef = { id: string; minChoices: number; maxChoices: number; choices: Array<{ variantId: string; upgradePesewas: number }> };
export type ComboChoice = { slotId: string; variantId: string };

/** Spec 6.52: every slot gets min..max distinct choices from its own list; a choice sold out today is refused. */
export function checkComboChoices(slots: ComboSlotDef[], chosen: ComboChoice[], soldOut: ReadonlySet<string>): 'ok' | 'invalid_choices' | 'sold_out' {
  if (chosen.some((c) => !slots.some((s) => s.id === c.slotId))) return 'invalid_choices';
  for (const slot of slots) {
    const picks = chosen.filter((c) => c.slotId === slot.id).map((c) => c.variantId);
    if (picks.length < slot.minChoices || picks.length > slot.maxChoices || new Set(picks).size !== picks.length) return 'invalid_choices';
    if (picks.some((v) => !slot.choices.some((c) => c.variantId === v))) return 'invalid_choices';
  }
  return chosen.some((c) => soldOut.has(c.variantId)) ? 'sold_out' : 'ok';
}

/** Sum of the chosen upgrade prices, in pesewas; call after checkComboChoices says 'ok'. */
export function comboUpgradeTotal(slots: ComboSlotDef[], chosen: ComboChoice[]): number {
  return chosen.reduce((sum, c) => sum + (slots.find((s) => s.id === c.slotId)?.choices.find((x) => x.variantId === c.variantId)?.upgradePesewas ?? 0), 0);
}

/** Spec 6.54: expected sales from the pots eaten; flagged when the gap is above the shop's limit (exactly the limit is fine). */
export function potVariance(i: { cookedQty: string; leftoverQty: string; valuePerPotPesewas: number | null; actualPesewas: number; limitBp: number }):
  { expectedPesewas: number | null; variancePesewas: number | null; flagged: boolean } {
  if (i.valuePerPotPesewas === null) return { expectedPesewas: null, variancePesewas: null, flagged: false };
  const eaten = fromMilli(toMilli(i.cookedQty) - toMilli(i.leftoverQty));
  const expected = pesewasTimesQty(i.valuePerPotPesewas, eaten);
  const variance = i.actualPesewas - expected;
  const flagged = expected > 0 && BigInt(Math.abs(variance)) * 10000n > BigInt(expected) * BigInt(i.limitBp);
  return { expectedPesewas: expected, variancePesewas: variance, flagged };
}

export type ChannelKind = 'delivery_app' | 'phone' | 'whatsapp';

/** Spec 6.57: the app’s cut of a sale, in pesewas, rounded half up. */
export function commissionPesewas(totalPesewas: number, commissionBp: number): number {
  return Number(divHalfUp(BigInt(totalPesewas) * BigInt(commissionBp), 10000n));
}

/**
 * Spec 6.52 (reports): shares a combo net price across its parts in proportion to their usual prices.
 * Each part gets the floor of its share; the pesewas left over go to the largest part (the first on a tie), so the shares add up to .
 */
export function splitComboNet(netPesewas: number, parts: Array<{ key: string; weightPesewas: number }>): Map<string, number> {
  const total = parts.reduce((sum, p) => sum + p.weightPesewas, 0);
  const shares = new Map(parts.map((p) => [p.key, total > 0 ? Math.floor((netPesewas * p.weightPesewas) / total) : 0]));
  const largest = total > 0 ? parts.reduce((best, p) => (p.weightPesewas > best.weightPesewas ? p : best), parts[0]) : parts[0];
  if (largest) shares.set(largest.key, shares.get(largest.key)! + netPesewas - [...shares.values()].reduce((a, b) => a + b, 0));
  return shares;
}

/** Spec 6.57: a phone or WhatsApp customer needs a name, a Ghana phone, and a pickup time or a delivery address; null when any is missing. */
export function phoneCustomer(i: { customer?: { name: string; phone: string }; pickupAt?: string; deliveryAddress?: string }):
  { name: string; phone: string; pickupAt: Date | null; deliveryAddress: string | null } | null {
  const name = i.customer?.name.trim() ?? '';
  const phone = i.customer ? normaliseGhanaPhone(i.customer.phone) : null;
  const deliveryAddress = i.deliveryAddress?.trim() || null;
  if (name.length < 1 || name.length > 80 || !phone || (!i.pickupAt && !deliveryAddress) || (deliveryAddress?.length ?? 0) > 200) return null;
  return { name, phone, pickupAt: i.pickupAt ? new Date(i.pickupAt) : null, deliveryAddress };
}

/** Spec 4.24: add-ons chosen for one line, such as Protein: Fish. */
export type AddOnChoice = { groupId: string; optionId: string };
export type AddOnGroupDef = { id: string; minChoices: number; maxChoices: number; options: Array<{ id: string; pricePesewas: number; active: boolean }> };

/** Stale: an add-on the item no longer offers (an edit after the till built the cart). Invalid: a count outside a group's limits, or a repeat. */
export function checkAddOns(groups: AddOnGroupDef[], chosen: AddOnChoice[]): 'ok' | 'invalid_add_ons' | 'stale_add_ons' {
  // counts first, so a stale choice never hides a skipped required group; a stale choice still counts toward its own group
  if (new Set(chosen.map((c) => `${c.groupId}:${c.optionId}`)).size !== chosen.length) return 'invalid_add_ons';
  const counts = groups.every((g) => {
    const n = chosen.filter((c) => c.groupId === g.id).length;
    return n >= g.minChoices && n <= g.maxChoices;
  });
  if (!counts) return 'invalid_add_ons';
  const known = (c: AddOnChoice) => groups.find((g) => g.id === c.groupId)?.options.some((o) => o.id === c.optionId && o.active);
  return chosen.every(known) ? 'ok' : 'stale_add_ons';
}

export function addOnTotal(groups: AddOnGroupDef[], chosen: AddOnChoice[]): number {
  return chosen.reduce((sum, c) => sum + (groups.find((g) => g.id === c.groupId)?.options.find((o) => o.id === c.optionId)?.pricePesewas ?? 0), 0);
}

export function sameAddOns(a: AddOnChoice[] = [], b: AddOnChoice[] = []): boolean {
  const key = (l: AddOnChoice[]) => l.map((c) => `${c.groupId}:${c.optionId}`).sort().join(',');
  return key(a) === key(b);
}
