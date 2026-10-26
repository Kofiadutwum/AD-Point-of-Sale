import { expect, it } from 'vitest';
import { formatReceiptNumber, parseReceiptNumber, receiptShareText, whatsappShareUrl } from '@/lib/receipt';

it('formats and parses receipt numbers', () => {
  expect(formatReceiptNumber('ACC1', 'T2', 123)).toBe('ACC1-T2-000123');
  expect(parseReceiptNumber('ACC1-T2-000123')).toEqual({ branchCode: 'ACC1', registerCode: 'T2', counter: 123 });
  for (const bad of ['ACC1-T2-123', 'acc1-T2-000123', 'ACC1-T2-0001234', 'ACC1T2000123']) expect(parseReceiptNumber(bad), bad).toBeNull();
});

it('builds the WhatsApp share link', () => {
  const text = receiptShareText({ shopName: 'Ama Shop', receiptNumber: 'B1-T1-000007', totalPesewas: 2300, url: 'https://x.test/ama/r/abc' });
  expect(text).toBe('Ama Shop\nReceipt B1-T1-000007\nTotal GHS 23.00\nhttps://x.test/ama/r/abc');
  expect(whatsappShareUrl('a b')).toBe('https://wa.me/?text=a%20b');
  expect(whatsappShareUrl('a', '233241234567')).toBe('https://wa.me/233241234567?text=a');
});
