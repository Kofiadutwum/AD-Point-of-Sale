import { expect, it } from 'vitest';
import { readProductFields, readVariantFields } from '@/app/[slug]/app/products/form-data';

const form = (entries: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
};

it('leaves out fields the page did not show, so the save keeps them', () => {
  expect(readProductFields(form({ name: 'Amoxil', tracking: 'none' })).pharmacy).toBeUndefined();
  expect(readProductFields(form({ name: 'Amoxil', tracking: 'none', genericName: 'amoxicillin' })).pharmacy)
    .toMatchObject({ genericName: 'amoxicillin', prescriptionOnly: false });
  expect(readVariantFields(form({ name: '', price: '1.00', cost: '1.00', costShown: '1.00' })).scaleItemCode).toBeUndefined();
  expect(readVariantFields(form({ name: '', price: '1.00', cost: '1.00', costShown: '1.00', scaleItemCode: '' })).scaleItemCode).toBeNull();
  expect(readVariantFields(form({ name: '', price: '1.00', cost: '1.00', costShown: '1.00', scaleItemCode: '123' })).scaleItemCode).toBe(123);
});
