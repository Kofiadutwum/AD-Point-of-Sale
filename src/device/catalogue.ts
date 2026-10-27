import { normaliseBarcode, readScaleLabel } from '@/lib/barcode';
import { type CartTotals, calculateCartTotals } from '@/lib/cart-totals';
import { fromMilli, ratioToQty, validSaleQuantity } from '@/lib/decimal';
import type { DeviceCache } from '@/lib/device-contract';
import { checkComboChoices, type ComboChoice, comboUpgradeTotal, type DiningOption, packCount } from '@/lib/food';
import { choosePriceList, resolvePrice } from '@/lib/pricing';
import { chooseTaxRule } from '@/lib/tax';

// The till's catalogue lookups, run against the cached catalogue so they work offline (spec 6.5, 6.21, 6.22).

export type Found = { variantId: string; unitId: string; quantity: string; labelPricePesewas: number | null };
export type SearchHit = { variantId: string; unitId: string; label: string; unitName: string; pricePesewas: number; imageId: string | null };
export type CartLine = {
  lineId: string; variantId: string; unitId: string; quantity: string; labelPricePesewas: number | null;
  amountPesewas?: number | null; choices?: ComboChoice[]; // sold by amount (spec 6.53); combo choices (spec 6.52)
};
export type PricedLine = CartLine & { label: string; unitName: string; unitPricePesewas: number; taxRateBp: number };

const labelOf = (productName: string, variantName: string) => (variantName ? `${productName} – ${variantName}` : productName);

/** Same rules as the server's parseScannedCode: scale labels first (a bad check digit is never retried), then barcodes. */
export function findByCode(cache: DeviceCache, code: string): Found | null {
  const clean = normaliseBarcode(code);
  if (!clean) return null;
  const label = readScaleLabel(clean, cache.shop.scaleLayout);
  if (label === 'bad_check_digit') return null;
  if (label) {
    const variant = cache.variants.find((v) => v.scaleItemCode === label.itemCode);
    const unit = variant && cache.units.find((u) => u.variantId === variant.id && u.isBase);
    if (!variant || !unit) return null;
    if (cache.shop.scaleLayout!.carries === 'weight') return { variantId: variant.id, unitId: unit.id, quantity: fromMilli(BigInt(label.value)), labelPricePesewas: null };
    if (variant.basePricePesewas <= 0) return null;
    return { variantId: variant.id, unitId: unit.id, quantity: ratioToQty(BigInt(label.value), BigInt(variant.basePricePesewas)), labelPricePesewas: label.value };
  }
  const hit = cache.barcodes.find((b) => b.code === clean);
  return hit ? { variantId: hit.variantId, unitId: hit.unitId, quantity: '1.000', labelPricePesewas: null } : null;
}

function parts(cache: DeviceCache, variantId: string, unitId: string) {
  const variant = cache.variants.find((v) => v.id === variantId);
  const product = variant && cache.products.find((p) => p.id === variant.productId);
  const unit = cache.units.find((u) => u.id === unitId && u.variantId === variantId);
  return variant && product && unit ? { variant, product, unit } : null;
}

/** Why this item cannot go in the cart, or null. */
/** `today` is the device business date; a sold-out list from another date is stale and ignored (the server checks again on sync). */
export function canAdd(
  cache: DeviceCache, found: Found & { amountPesewas?: number | null; choices?: ComboChoice[] }, today?: string,
): 'unavailable' | 'serial_item' | 'invalid_quantity' | 'sold_out' | 'amount_required' | 'below_minimum_amount' | 'invalid_choices' | null {
  const p = parts(cache, found.variantId, found.unitId);
  if (!p || p.product.status !== 'active' || p.variant.status !== 'active' || !p.variant.sellable || !p.unit.sellable) return 'unavailable';
  const soldOutToday = cache.food && today === cache.food.businessDate ? new Set(cache.food.soldOutVariantIds) : new Set<string>();
  if (soldOutToday.has(found.variantId)) return 'sold_out';
  if (p.variant.sellByAmount) {
    if (found.amountPesewas == null) return 'amount_required';
    if (found.amountPesewas < (p.variant.minAmountPesewas ?? 0)) return 'below_minimum_amount';
  }
  if (p.variant.kind === 'combo') {
    const check = checkComboChoices(comboSlotsOf(cache, found.variantId), found.choices ?? [], soldOutToday);
    if (check !== 'ok') return check;
  }
  if (p.product.tracking === 'serial') return 'serial_item'; // the device till has no serial picker yet
  return validSaleQuantity(found.quantity, p.unit.isBase && p.variant.allowsFractions) ? null : 'invalid_quantity';
}

function unitPrice(
  cache: DeviceCache, variant: { basePricePesewas: number }, unit: { id: string; factor: string; pricePesewas: number | null }, quantity: string, today: string,
  priceListId: string | null = null,
) {
  const list = choosePriceList(cache.priceRules, { cartListId: priceListId, customerListId: null, branchId: cache.register.branchId, today });
  return resolvePrice(list, { unitId: unit.id, quantity, unitPricePesewas: unit.pricePesewas, unitFactor: unit.factor, basePricePesewas: variant.basePricePesewas });
}

export function searchCatalogue(cache: DeviceCache, text: string, today: string): SearchHit[] {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const v of cache.variants) {
    const p = cache.products.find((x) => x.id === v.productId);
    const unit = cache.units.find((u) => u.variantId === v.id && u.isBase);
    if (!p || !unit || p.status !== 'active' || v.status !== 'active' || !v.sellable) continue;
    if (![p.name, p.genericName, v.sku, v.name].some((s) => s?.toLowerCase().includes(q))) continue;
    hits.push({ variantId: v.id, unitId: unit.id, label: labelOf(p.name, v.name), unitName: unit.name, pricePesewas: unitPrice(cache, v, unit, '1.000', today), imageId: p.imageId });
    if (hits.length === 20) break;
  }
  return hits;
}

/** Cart lines priced from the cache (price lists, tax rules), with spec 6.6 totals. Lines whose item vanished from the cache are dropped. */
/** The combo slots the cache holds for one combo, in order. */
export function comboSlotsOf(cache: DeviceCache, comboVariantId: string) {
  return cache.comboSlots.filter((s) => s.comboVariantId === comboVariantId).sort((a, b) => a.sortOrder - b.sortOrder);
}

/** `priceListId`: a channel's own prices (spec 6.57); walk-in uses the branch or retail list. */
export function priceCart(
  cache: DeviceCache, lines: CartLine[], today: string, opts: { priceListId?: string | null } = {},
): { lines: PricedLine[]; totals: CartTotals } {
  const priced: PricedLine[] = [];
  for (const l of lines) {
    const p = parts(cache, l.variantId, l.unitId);
    if (!p) continue;
    const rule = chooseTaxRule(cache.shop.taxEnabled, p.product.taxRuleId, cache.taxRules);
    priced.push({
      ...l, label: labelOf(p.product.name, p.variant.name), unitName: p.unit.name,
      unitPricePesewas: p.variant.sellByAmount && l.amountPesewas != null ? l.amountPesewas
        : unitPrice(cache, p.variant, p.unit, l.quantity, today, opts.priceListId ?? null) + (p.variant.kind === 'combo' ? comboUpgradeTotal(comboSlotsOf(cache, l.variantId), l.choices ?? []) : 0),
      taxRateBp: rule?.rateBp ?? 0,
    });
  }
  const totals = calculateCartTotals(priced.map((l) => ({ ...l, discountPesewas: 0 })), { taxMode: cache.shop.taxMode });
  return { lines: priced, totals };
}

/** Spec 6.56: adds, resizes, or removes the pack line (lineId 'pack') so the cart always carries the packs it owes. */
export function withPackLine(cache: DeviceCache, lines: CartLine[], diningOption: DiningOption): CartLine[] {
  const food = cache.food;
  // a pack scanned by hand is dropped too: the pack line is always the one this function owes
  const items = lines.filter((l) => l.lineId !== 'pack' && l.variantId !== food?.packVariantId);
  const packUnit = food?.packVariantId ? cache.units.find((u) => u.variantId === food.packVariantId && u.isBase) : undefined;
  if (!food || !packUnit) return items;
  const packs = packCount(items, {
    diningOption, mode: food.packFeeMode, packVariantId: food.packVariantId,
    needsPack: (id) => cache.variants.find((v) => v.id === id)?.needsPack ?? false,
  });
  if (packs === 0) return items;
  const quantity = fromMilli(BigInt(packs) * 1000n);
  const current = lines.find((l) => l.lineId === 'pack');
  if (current?.quantity === quantity) return lines;
  return [...items, { lineId: 'pack', variantId: food.packVariantId!, unitId: packUnit.id, quantity, labelPricePesewas: null }];
}
