// Date-only values are 'YYYY-MM-DD' strings; arithmetic happens in UTC so it never shifts with DST.

export function todayIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y, m, d];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  const [y, m, d] = parts(date);
  return iso(new Date(Date.UTC(y, m - 1, d + days)));
}

/** Clamps to the last day of the target month: 2026-01-31 + 1 month = 2026-02-28. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = parts(date);
  const lastDay = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(y, m - 1 + months, Math.min(d, lastDay))));
}

export function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = parts(from);
  const [y2, m2, d2] = parts(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** The shop's business day for a moment: a local time before the cutoff ('HH:MM') belongs to the previous day (spec 4.7). */
export function businessDate(timeZone: string, cutoff: string, at: Date): string {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  const today = todayIn(timeZone, at);
  return time < cutoff ? addDays(today, -1) : today;
}
