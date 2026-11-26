import { expect, it } from 'vitest';
import { parseCsv } from '@/lib/csv-parse';

it('reads quoted fields, commas, quotes, and line ends', () => {
  expect(parseCsv('\uFEFFname,price\r\n"Milo, 400g",12.50\n"Say ""hi""",1\n\n')).toEqual([['name', 'price'], ['Milo, 400g', '12.50'], ['Say "hi"', '1']]);
  expect(parseCsv('a,b\n"line\nbreak",x')).toEqual([['a', 'b'], ['line\nbreak', 'x']]);
  expect(parseCsv('a,"open')).toBeNull();
});
