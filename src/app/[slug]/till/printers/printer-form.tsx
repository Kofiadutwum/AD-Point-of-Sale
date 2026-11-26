'use client';
import { useState, useSyncExternalStore } from 'react';
import type { KitchenStation } from '@/lib/kitchen-slip';
import { helperStatus, loadPrinterSettings, type PrinterSettings, printKitchenSlips, savePrinterSettings } from '@/lib/print-client';

const STATIONS: KitchenStation[] = ['kitchen', 'bar', 'grill'];
const input = 'rounded border border-gray-400 px-3 py-2';

export function PrinterForm({ slug }: { slug: string }) {
  // localStorage exists only in the browser: render nothing on the server, read settings on the first browser render
  const mounted = useSyncExternalStore(() => () => {}, () => true, () => false);
  const [s, setS] = useState<PrinterSettings | null>(() => (typeof window === 'undefined' ? null : loadPrinterSettings(slug)));
  const [printers, setPrinters] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  if (!mounted || !s) return null;

  const test = async () => {
    const r = await helperStatus(s);
    if (r.ok) { setPrinters(r.printers); setMessage(`Helper found. Printers: ${r.printers.join(', ') || 'none in its config.json'}.`); }
    else setMessage(r.error === 'wrong_token' ? 'The token does not match the helper.' : r.error === 'origin_not_allowed'
      ? `Add ${location.origin} to allowedOrigins in the helper's config.json.` : 'The helper is not reachable. Is it running on this computer?');
  };
  const save = () => { savePrinterSettings(slug, s); setMessage('Saved on this device.'); };
  const testSlip = async () => {
    const r = await printKitchenSlips(s, {
      kind: 'new', orderNumber: 'TEST', dining: 'eat_in', at: new Date(), timezone: 'Africa/Accra',
      lines: STATIONS.filter((st) => s.stations[st]).map((station) => ({ name: `Test slip for ${station}`, quantity: '1', station })),
    });
    setMessage(r.printed.length || r.failed.length ? `Printed: ${r.printed.join(', ') || 'none'}. Failed: ${r.failed.join(', ') || 'none'}.` : 'Choose a printer for at least one station first.');
  };

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">Helper address
        <input className={input} value={s.helperUrl} onChange={(e) => setS({ ...s, helperUrl: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Token (from the helper&apos;s config.json)
        <input className={input} type="password" autoComplete="off" value={s.token} onChange={(e) => setS({ ...s, token: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Paper width
        <select className={input} value={s.width} onChange={(e) => setS({ ...s, width: Number(e.target.value) === 48 ? 48 : 32 })}>
          <option value={32}>58 mm</option><option value={48}>80 mm</option>
        </select>
      </label>
      <button type="button" onClick={test} className="rounded border border-blue-800 px-4 py-2 text-blue-800">Find the helper</button>
      {STATIONS.map((station) => (
        <label key={station} className="flex flex-col gap-1 text-sm">Printer for the {station}
          <input className={input} list="helper-printers" placeholder="No printer (kitchen display only)" value={s.stations[station] ?? ''}
            onChange={(e) => setS({ ...s, stations: { ...s.stations, [station]: e.target.value.trim() || undefined } })} />
        </label>
      ))}
      <datalist id="helper-printers">{printers.map((p) => <option key={p} value={p} />)}</datalist>
      <button type="button" onClick={save} className="rounded bg-blue-800 px-4 py-2 text-white">Save</button>
      <button type="button" onClick={testSlip} className="rounded border border-gray-500 px-4 py-2">Print a test slip</button>
      {message && <p role="status" className="text-sm">{message}</p>}
    </div>
  );
}
