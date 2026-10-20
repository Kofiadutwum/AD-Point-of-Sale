import { expect, it } from 'vitest';
import { canAdd, findByCode, priceCart, searchCatalogue } from '@/device/catalogue';
import { ean13CheckDigit } from '@/lib/barcode';
import type { DeviceCache } from '@/lib/device-contract';

const P = (id: string, name: string, extra: Partial<DeviceCache['products'][number]> = {}) =>
  ({ id, name, genericName: null, taxRuleId: null, tracking: 'none' as const, status: 'active' as const, imageId: null, ...extra });
const V = (id: string, productId: string, price: number, extra: Partial<DeviceCache['variants'][number]> = {}) =>
  ({ id, productId, name: '', sku: null, allowsFractions: false, basePricePesewas: price, scaleItemCode: null, sellable: true, status: 'active' as const, ...extra });
const U = (id: string, variantId: string, extra: Partial<DeviceCache['units'][number]> = {}) =>
  ({ id, variantId, name: 'piece', factor: '1.000', pricePesewas: null, sellable: true, isBase: true, ...extra });

const cache: DeviceCache = {
  version: 1, generatedAt: '',
  shop: { name: 'A', timezone: 'Africa/Accra', taxMode: 'exclusive', taxEnabled: true, offlineEnabled: true, canSell: true,
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
