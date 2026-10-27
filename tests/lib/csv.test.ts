import { expect, it } from 'vitest';
import { toCsv } from '@/lib/csv';

it('neutralises formula cells', () => {
  expect(toCsv([['=HYPERLINK("x")', '-Special', '@a', '+1', 'Ok, "fine"', -2400, null]]))
    .toBe(`"'=HYPERLINK(""x"")",'-Special,'@a,'+1,"Ok, ""fine""",-2400,\r\n`);
});

it('writes rows with CRLF line ends', () => {
  expect(toCsv([['a', 1], ['b', 2]])).toBe('a,1\r\nb,2\r\n');
});
