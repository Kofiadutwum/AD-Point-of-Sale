import { expect, it } from 'vitest';
import { ean13CheckDigit, ean13Valid, matchesScaleLayout, normaliseBarcode, readScaleLabel, validScaleLayout } from '@/lib/barcode';
import { PRICE_LAYOUT, WEIGHT_LAYOUT } from '../helpers/fixtures';

it('normalises barcodes', () => {
  expect(normaliseBarcode(' 6001234567890\r\n')).toBe('6001234567890');
  expect(normaliseBarcode('036000291452')).toBe('0036000291452');
  expect(normaliseBarcode('0036000291452')).toBe('0036000291452');
  for (const bad of ['', 'ABC 123', 'x'.repeat(65)]) expect(normaliseBarcode(bad), bad).toBeNull();
});

it('checks EAN-13 check digits', () => {
  expect(ean13CheckDigit('400638133393')).toBe('1');
  expect(ean13Valid('4006381333931')).toBe(true);
  expect(ean13Valid('4006381333932')).toBe(false);
});

it('reads weight and price labels', () => {
  expect(readScaleLabel('2100123012503', WEIGHT_LAYOUT)).toEqual({ itemCode: 123, value: 1250 });
  expect(readScaleLabel('2200456007501', PRICE_LAYOUT)).toEqual({ itemCode: 456, value: 750 });
});

it('rejects a label with a wrong check digit and ignores other codes', () => {
  expect(readScaleLabel('2100123012504', WEIGHT_LAYOUT)).toBe('bad_check_digit');
  expect(readScaleLabel('6001234567890', WEIGHT_LAYOUT)).toBeNull();
  expect(readScaleLabel('2100123012503', null)).toBeNull();
  expect(matchesScaleLayout('2100000000000', WEIGHT_LAYOUT)).toBe(true);
});

it('validates layouts', () => {
  expect(validScaleLayout(WEIGHT_LAYOUT)).toBe(true);
  expect(validScaleLayout({ ...WEIGHT_LAYOUT, prefix: '3' })).toBe(false);
  expect(validScaleLayout({ ...WEIGHT_LAYOUT, valueStart: 5 })).toBe(false); // overlaps item
  expect(validScaleLayout({ ...WEIGHT_LAYOUT, valueLength: 6 })).toBe(false); // reaches the check digit
  expect(validScaleLayout({ ...WEIGHT_LAYOUT, itemStart: 1 })).toBe(false); // overlaps prefix
});
