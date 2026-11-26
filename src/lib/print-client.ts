import { escpos } from './escpos';
import { type KitchenSlipOrder, type KitchenStation, kitchenSlips } from './kitchen-slip';

/** This till's printers: the local print helper's address and token, and which helper printer each kitchen station uses (spec 11). */
export type PrinterSettings = { helperUrl: string; token: string; width: 32 | 48; stations: Partial<Record<KitchenStation, string>> };
const EMPTY: PrinterSettings = { helperUrl: 'http://127.0.0.1:17777', token: '', width: 32, stations: {} };
const key = (slug: string) => `pos-printers-${slug}`;

export function loadPrinterSettings(slug: string): PrinterSettings {
  try {
    const raw = localStorage.getItem(key(slug));
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

export function savePrinterSettings(slug: string, s: PrinterSettings): void {
  try { localStorage.setItem(key(slug), JSON.stringify(s)); } catch { /* storage blocked: settings last for this page only */ }
}

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** The helper's printer names, or why it cannot be reached. */
export async function helperStatus(s: PrinterSettings): Promise<{ ok: true; printers: string[] } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${s.helperUrl.replace(/\/$/, '')}/status`, { headers: { 'x-print-token': s.token } });
    const body = await res.json().catch(() => null);
    return res.ok && body?.ok ? { ok: true, printers: body.printers } : { ok: false, error: body?.error ?? `status ${res.status}` };
  } catch {
    return { ok: false, error: 'not_reachable' };
  }
}

/** Prints one slip per station that has a printer; stations without one are skipped (the kitchen display still shows them). */
export async function printKitchenSlips(s: PrinterSettings, order: KitchenSlipOrder): Promise<{ printed: KitchenStation[]; failed: KitchenStation[] }> {
  const printed: KitchenStation[] = [];
  const failed: KitchenStation[] = [];
  if (!s.token) return { printed, failed };
  for (const slip of kitchenSlips(order)) {
    const printer = s.stations[slip.station];
    if (!printer) continue;
    try {
      const res = await fetch(`${s.helperUrl.replace(/\/$/, '')}/print`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-print-token': s.token },
        body: JSON.stringify({ printer, data: base64(escpos(slip.lines, { width: s.width })) }),
      });
      (res.ok ? printed : failed).push(slip.station);
    } catch {
      failed.push(slip.station);
    }
  }
  return { printed, failed };
}
