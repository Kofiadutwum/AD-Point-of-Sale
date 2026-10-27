import { expect, it } from 'vitest';
import { canAdd, type CartLine, findByCode, priceCart, searchCatalogue, withPackLine } from '@/device/catalogue';
import { ean13CheckDigit } from '@/lib/barcode';
import type { DeviceCache } from '@/lib/device-contract';

const P = (id: string, name: string, extra: Partial<DeviceCache['products'][number]> = {}) =>
  ({ id, name, genericName: null, taxRuleId: null, tracking: 'none' as const, status: 'active' as const, imageId: null, ...extra });
const V = (id: string, productId: string, price: number, extra: Partial<DeviceCache['variants'][number]> = {}) =>
  ({ id, productId, name: '', sku: null, allowsFractions: false, basePricePesewas: price, scaleItemCode: null, sellable: true, status: 'active' as const, needsPack: false,
    kind: 'standard' as const, sellByAmount: false, minAmountPesewas: null, ...extra });
const U = (id: string, variantId: string, extra: Partial<DeviceCache['units'][number]> = {}) =>
  ({ id, variantId, name: 'piece', factor: '1.000', pricePesewas: null, sellable: true, isBase: true, ...extra });

const cache: DeviceCache = {
  version: 1, generatedAt: '',
  shop: { name: 'A', timezone: 'Africa/Accra', taxMode: 'exclusive', taxEnabled: true, offlineEnabled: true, canSell: true, businessDayCutoff: '00:00',
    scaleLayout: { prefix: '21', itemStart: 2, itemLength: 5, valueStart: 7, valueLength: 5, carries: 'weight' } },
  register: { id: 'r', name: 'Till 1', registerCode: 'T1', branchId: 'b1', branchCode: 'B1', branchName: 'Main' },
  staff: [],
  taxRules: [{ id: 'vat', isDefault: true, rateBp: 1500 }, { id: 'zero', isDefault: false, rateBp: 0 }],
  priceRules: [{ id: 'br', kind: 'branch', branchId: 'b1', startsOn: null, endsOn: null, active: true, items: [{ unitId: 'u-milo', minQuantity: '1.000', pricePesewas: 2400 }] }],
  products: [P('p-milo', 'Milo 400g'), P('p-rice', 'Rice', { taxRuleId: 'zero' }), P('p-old', 'Old item', { status: 'archived' }), P('p-phone', 'Phone', { tracking: 'serial' }),
    P('p-para', 'Panadol', { genericName: 'Paracetamol' })],
  variants: [V('v-milo', 'p-milo', 2500, { sku: 'MILO400' }), V('v-rice', 'p-rice', 1200, { allowsFractions: true, scaleItemCode: 123 }), V('v-old', 'p-old', 100),
    V('v-phone', 'p-phone', 90000), V('v-para', 'p-para', 50)],
  units: [U('u-milo', 'v-milo'), U('u-rice', 'v-rice', { name: 'kg' }), U('u-old', 'v-old'), U('u-phone', 'v-phone'), U('u-para', 'v-para', { name: 'tablet' }),
    U('u-strip', 'v-para', { name: 'strip', factor: '10.000', isBase: false })],
  barcodes: [{ code: '6001234567890', variantId: 'v-milo', unitId: 'u-milo' }, { code: '0123456789012', variantId: 'v-old', unitId: 'u-old' }],
  resolvedHeldSaleIds: [],
  food: null,
  comboSlots: [],
};
const today = '2026-10-20';
const label = (first12: string) => first12 + ean13CheckDigit(first12);

it('finds a barcode, a 12-digit UPC, and a weight scale label', () => {
  expect(findByCode(cache, ' 6001234567890 ')).toEqual({ variantId: 'v-milo', unitId: 'u-milo', quantity: '1.000', labelPricePesewas: null });
  expect(findByCode(cache, '123456789012')).toMatchObject({ variantId: 'v-old' });
  expect(findByCode(cache, label('210012301250'))).toEqual({ variantId: 'v-rice', unitId: 'u-rice', quantity: '1.250', labelPricePesewas: null });
  expect(findByCode(cache, 'nope')).toBeNull();
});

it('rejects a scale label with a wrong check digit', () => {
  const good = label('210012301250');
  expect(findByCode(cache, good.slice(0, 12) + ((Number(good[12]) + 1) % 10))).toBeNull();
});

it('prices with the branch price list and the product tax rule', () => {
  const r = priceCart(cache, [
    { lineId: '1', variantId: 'v-milo', unitId: 'u-milo', quantity: '2.000', labelPricePesewas: null },
    { lineId: '2', variantId: 'v-rice', unitId: 'u-rice', quantity: '0.500', labelPricePesewas: null },
    { lineId: '3', variantId: 'v-para', unitId: 'u-strip', quantity: '1.000', labelPricePesewas: null },
  ], today);
  expect(r.lines.map((l) => [l.label, l.unitName, l.unitPricePesewas, l.taxRateBp])).toEqual([
    ['Milo 400g', 'piece', 2400, 1500], ['Rice', 'kg', 1200, 0], ['Panadol', 'strip', 500, 1500],
  ]);
  expect(r.totals).toMatchObject({ subtotalPesewas: 4800 + 600 + 500, taxPesewas: 720 + 0 + 75 });
});

it('refuses archived, serial, and fractional-in-whole-unit items', () => {
  const f = (variantId: string, unitId: string, quantity = '1.000') => ({ variantId, unitId, quantity, labelPricePesewas: null });
  expect(canAdd(cache, f('v-old', 'u-old'))).toBe('unavailable');
  expect(canAdd(cache, f('v-phone', 'u-phone'))).toBe('serial_item');
  expect(canAdd(cache, f('v-milo', 'u-milo', '0.500'))).toBe('invalid_quantity');
  expect(canAdd(cache, f('v-rice', 'u-rice', '0.500'))).toBeNull();
});

it('searches name, generic name, and SKU among sellable items', () => {
  expect(searchCatalogue(cache, 'milo', today).map((h) => h.variantId)).toEqual(['v-milo']);
  expect(searchCatalogue(cache, 'paracet', today)).toEqual([expect.objectContaining({ variantId: 'v-para', unitId: 'u-para', pricePesewas: 50 })]);
  expect(searchCatalogue(cache, 'MILO400', today)).toHaveLength(1);
  expect(searchCatalogue(cache, 'old', today)).toEqual([]);
  expect(searchCatalogue(cache, '', today)).toEqual([]);
});

const foodCache: DeviceCache = {
  ...cache,
  products: [...cache.products, P('p-pack', 'Takeaway pack')],
  variants: [...cache.variants.map((v) => (v.id === 'v-rice' ? { ...v, needsPack: true } : v)), V('v-pack', 'p-pack', 100)],
  units: [...cache.units, U('u-pack', 'v-pack')],
  food: { serviceModes: ['counter', 'quick'], packVariantId: 'v-pack', packFeeMode: 'per_order', businessDate: today, soldOutVariantIds: ['v-milo'] },
};
const milo: CartLine = { lineId: 'l1', variantId: 'v-milo', unitId: 'u-milo', quantity: '1.000', labelPricePesewas: null };
const rice = (quantity: string): CartLine => ({ lineId: 'l2', variantId: 'v-rice', unitId: 'u-rice', quantity, labelPricePesewas: null });

it('refuses a sold-out item', () => {
  expect(canAdd(foodCache, { variantId: 'v-milo', unitId: 'u-milo', quantity: '1.000', labelPricePesewas: null }, today)).toBe('sold_out');
});

it('ignores a sold-out list from another business date', () => {
  expect(canAdd(foodCache, { variantId: 'v-milo', unitId: 'u-milo', quantity: '1.000', labelPricePesewas: null }, '2026-10-21')).toBeNull();
});

it('adds one pack line for a takeaway order', () => {
  const lines = withPackLine(foodCache, [milo, rice('2.000')], 'takeaway');
  expect(lines).toEqual([milo, rice('2.000'), { lineId: 'pack', variantId: 'v-pack', unitId: 'u-pack', quantity: '1.000', labelPricePesewas: null }]);
  expect(withPackLine(foodCache, lines, 'delivery')).toEqual(lines); // already right: unchanged
});

it('switching to eat in removes the pack line', () => {
  expect(withPackLine(foodCache, withPackLine(foodCache, [milo], 'takeaway'), 'eat_in')).toEqual([milo]);
});

it('per-item packs follow the cart quantity', () => {
  const perItem: DeviceCache = { ...foodCache, food: { ...foodCache.food!, packFeeMode: 'per_item' } };
  expect(withPackLine(perItem, [milo, rice('1.500')], 'takeaway').find((l) => l.lineId === 'pack')!.quantity).toBe('2.000');
  expect(withPackLine(perItem, [milo], 'takeaway').find((l) => l.lineId === 'pack')).toBeUndefined(); // milo needs no pack
});

it('a pack scanned by hand is not counted twice', () => {
  const scanned: CartLine = { lineId: 'l9', variantId: 'v-pack', unitId: 'u-pack', quantity: '1.000', labelPricePesewas: null };
  const lines = withPackLine(foodCache, [milo, scanned], 'takeaway');
  expect(lines.filter((l) => l.variantId === 'v-pack')).toEqual([{ lineId: 'pack', variantId: 'v-pack', unitId: 'u-pack', quantity: '1.000', labelPricePesewas: null }]);
});

const menuCache: DeviceCache = {
  ...foodCache,
  products: [...foodCache.products, P('p-meal', 'Meal 2'), P('p-coke', 'Coke'), P('p-large', 'Large Coke'), P('p-jollof', 'Jollof')],
  variants: [...foodCache.variants, V('v-meal', 'p-meal', 4500, { kind: 'combo' }), V('v-coke', 'p-coke', 800), V('v-large', 'p-large', 1200),
    V('v-jollof', 'p-jollof', 1000, { kind: 'recipe', sellByAmount: true, minAmountPesewas: 500 })],
  units: [...foodCache.units, U('u-meal', 'v-meal'), U('u-coke', 'v-coke'), U('u-large', 'v-large'), U('u-jollof', 'v-jollof', { name: 'plate' })],
  comboSlots: [{ id: 'drink', comboVariantId: 'v-meal', name: 'Drink', sortOrder: 0, minChoices: 1, maxChoices: 1,
    choices: [{ variantId: 'v-coke', upgradePesewas: 0 }, { variantId: 'v-large', upgradePesewas: 500 }], choiceNames: { 'v-coke': 'Coke', 'v-large': 'Large Coke' } }],
  food: { ...foodCache.food!, soldOutVariantIds: ['v-coke'] },
};
const meal = (choices: Array<{ slotId: string; variantId: string }>) => ({ variantId: 'v-meal', unitId: 'u-meal', quantity: '1.000', labelPricePesewas: null, choices });

it('prices a combo with its upgrade', () => {
  const { lines } = priceCart(menuCache, [{ lineId: 'm', ...meal([{ slotId: 'drink', variantId: 'v-large' }]) }], today);
  expect(lines[0].unitPricePesewas).toBe(5000);
});

it('hides and refuses a sold-out choice', () => {
  expect(canAdd(menuCache, meal([{ slotId: 'drink', variantId: 'v-coke' }]), today)).toBe('sold_out');
  expect(canAdd(menuCache, meal([{ slotId: 'drink', variantId: 'v-large' }]), today)).toBeNull();
});

it('a combo needs its required choices', () => {
  expect(canAdd(menuCache, meal([]), today)).toBe('invalid_choices');
});

it('prices a by-amount line at the amount typed', () => {
  const line = { lineId: 'j', variantId: 'v-jollof', unitId: 'u-jollof', quantity: '1.000', labelPricePesewas: null, amountPesewas: 1500 };
  expect(canAdd(menuCache, line, today)).toBeNull();
  expect(priceCart(menuCache, [line], today).lines[0].unitPricePesewas).toBe(1500);
});

it('refuses an amount below the minimum', () => {
  const base = { variantId: 'v-jollof', unitId: 'u-jollof', quantity: '1.000', labelPricePesewas: null };
  expect(canAdd(menuCache, { ...base, amountPesewas: 400 }, today)).toBe('below_minimum_amount');
  expect(canAdd(menuCache, base, today)).toBe('amount_required');
});
