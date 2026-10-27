// CSV for report downloads (RFC 4180 quoting, CRLF line ends).

/** Text that a spreadsheet would run as a formula gets a leading quote mark (spec 6.59, acceptance: CSV neutralising). */
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  return rows.map((r) => `${r.map(cell).join(',')}\r\n`).join('');
}
