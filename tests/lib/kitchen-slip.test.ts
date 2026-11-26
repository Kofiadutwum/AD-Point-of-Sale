import { expect, it } from 'vitest';
import { escpos, toAscii, wrap } from '@/lib/escpos';
import { kitchenSlips } from '@/lib/kitchen-slip';

it('writes slips in plain ASCII and wraps long lines', () => {
  expect(toAscii('₵12 – Café × 2')).toBe('GHS 12 - Cafe x 2');
  expect(wrap('Banku and tilapia with pepper', 12)).toEqual(['Banku and', 'tilapia with', 'pepper']);
});

it('builds ESC/POS bytes: initialise, text, cut, and the drawer when asked', () => {
  const b = escpos([{ text: 'Hi', bold: true }]);
  expect([...b.slice(0, 2)]).toEqual([0x1b, 0x40]);
  expect(Buffer.from(b).includes(Buffer.from('Hi\n'))).toBe(true);
  expect([...b.slice(-4)]).toEqual([0x1d, 0x56, 66, 0]);
  expect([...escpos([{ text: 'x' }], { drawer: true }).slice(-5)]).toEqual([0x1b, 0x70, 0, 25, 250]);
});

it('prints one slip per station with only its items', () => {
  const slips = kitchenSlips({
    kind: 'new', orderNumber: '042', label: 'Table 5', dining: 'eat_in', at: new Date('2026-11-26T12:05:00Z'), timezone: 'Africa/Accra', by: 'Ama',
    lines: [
      { name: 'Jollof', quantity: '2.000', station: 'kitchen', addOns: ['Extra chicken'], note: 'no pepper' },
      { name: 'Club beer', quantity: '1.000', station: 'bar' },
    ],
  });
  expect(slips.map((s) => s.station)).toEqual(['kitchen', 'bar']);
  const kitchen = slips[0].lines.map((l) => l.text);
  expect(kitchen).toEqual(expect.arrayContaining(['KITCHEN', 'Order 042', 'Table 5', 'EAT IN  12:05', '2 x Jollof', '  + Extra chicken', '  ! no pepper', 'By Ama']));
  expect(kitchen).not.toContain('1 x Club beer');
  expect(kitchenSlips({ kind: 'cancel', orderNumber: null, dining: 'takeaway', at: new Date(), timezone: 'Africa/Accra', lines: [{ name: 'Waakye', quantity: '1', station: 'kitchen' }] })[0].lines.map((l) => l.text)).toContain('*** CANCEL ***');
});
