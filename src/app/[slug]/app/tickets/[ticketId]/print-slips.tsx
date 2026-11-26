'use client';
import { useEffect, useState } from 'react';
import type { KitchenSlipOrder } from '@/lib/kitchen-slip';
import { loadPrinterSettings, printKitchenSlips } from '@/lib/print-client';

/**
 * Spec 4.24: prints the ticket's latest "Send to kitchen" batch through the local print helper, once per batch (remembered for this tab),
 * with a button to print it again. Prints nothing when this device has no printers set.
 */
export function PrintSlips({ slug, batchKey, order }: { slug: string; batchKey: string | null; order: Omit<KitchenSlipOrder, 'at'> & { at: string } }) {
  const [message, setMessage] = useState<string | null>(null);
  const print = async () => {
    const r = await printKitchenSlips(loadPrinterSettings(slug), { ...order, at: new Date(order.at) });
    if (r.failed.length) setMessage(`Kitchen printer not reachable (${r.failed.join(', ')}). The kitchen display still has the order.`);
    else if (r.printed.length) setMessage(`Printed for ${r.printed.join(', ')}.`);
    else setMessage('No printer is set for these stations on this device (Printers, on the selling screen).');
  };
  useEffect(() => {
    if (!batchKey) return;
    const key = `pos-printed-${batchKey}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch { return; } // storage blocked: print by hand
    const s = loadPrinterSettings(slug);
    if (s.token && Object.values(s.stations).some(Boolean)) void printKitchenSlips(s, { ...order, at: new Date(order.at) });
  }, [batchKey, order, slug]);
  if (!batchKey) return null;
  return (
    <div className="flex flex-col gap-1">
      <button type="button" onClick={print} className="rounded border border-gray-500 px-3 py-1 text-sm">Print last kitchen send again</button>
      {message && <p role="status" className="text-sm">{message}</p>}
    </div>
  );
}
