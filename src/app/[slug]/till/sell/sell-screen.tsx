'use client';
import { useMemo, useState } from 'react';
import { canAdd, type CartLine, findByCode, priceCart, searchCatalogue } from '@/device/catalogue';
import type { TenderInput } from '@/device/sale';
import { todayIn } from '@/lib/dates';
import { formatCedis, parseCedis } from '@/lib/money';
import { type Receipt, useDevice } from './use-device';

const METHODS: Array<{ value: TenderInput['method']; label: string }> = [
  { value: 'cash', label: 'Cash' }, { value: 'momo_manual', label: 'MoMo' }, { value: 'card_terminal', label: 'Card' }, { value: 'bank_transfer', label: 'Bank' },
];
const ADD_ERRORS = {
  unavailable: 'Product unavailable', serial_item: 'Sell serial items on the online sell page.', invalid_quantity: 'Enter a valid quantity', sold_out: 'Sold out today',
} as const;
const btn = 'rounded border px-3 py-2';
const primary = 'rounded bg-blue-800 px-4 py-2 text-white disabled:opacity-50';

export function SellScreen({ slug }: { slug: string }) {
  const d = useDevice(slug);
  if (!d.loaded) return <main className="p-6">Loading the till…</main>;
  if (d.meta?.deregistered) {
    return (
      <main className="mx-auto max-w-md p-6">
        <p>This device was removed from the till. Its saved PINs were wiped. Ask a manager to register it again.</p>
        {d.outbox.length > 0 && <p className="mt-2 font-semibold">{d.outbox.length} sales are waiting on this device and will send once it is registered again.</p>}
      </main>
    );
  }
  if (!d.cache) return <main className="p-6">{d.reachable ? 'Setting up this till…' : 'Connect to the internet to set up this till.'}</main>;
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <StatusBar d={d} />
      {!d.cashier || d.needsPin ? <PinPanel d={d} /> : <Selling d={d} slug={slug} />}
      <Review d={d} />
    </main>
  );
}

type Device = ReturnType<typeof useDevice>;

function StatusBar({ d }: { d: Device }) {
  const waiting = d.outbox.filter((e) => e.status === 'queued').length;
  const review = d.outbox.length - waiting;
  const synced = d.meta?.lastSyncAt ? new Date(d.meta.lastSyncAt).toLocaleTimeString() : 'never';
  return (
    <header className="flex flex-wrap items-center gap-3 text-sm">
      <span className="font-semibold">{d.cache!.register.name}</span>
      <span role="status" className={`rounded px-2 py-1 ${d.reachable ? 'bg-green-100 text-green-900' : 'bg-amber-100 text-amber-900'}`}>
        {d.reachable ? 'Online' : 'Offline'}
      </span>
      {waiting > 0 && <span>{waiting} waiting</span>}
      {review > 0 && <span className="text-red-700">{review} need review</span>}
      <span className="text-gray-600">Last sync {synced}</span>
      {d.cashier && (
        <span className="ml-auto flex items-center gap-2">
          {d.cashier.name}
          <button type="button" className={btn} onClick={() => d.setCashier(null)}>Switch cashier</button>
        </span>
      )}
    </header>
  );
}

function PinPanel({ d }: { d: Device }) {
  const [staffId, setStaffId] = useState(d.cashier?.staffId ?? '');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const staff = d.cache!.staff;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await d.switchCashier(staffId, pin);
    setBusy(false);
    setPin('');
    setError(r.ok ? null : r.error);
  };
  return (
    <form onSubmit={submit} className="flex max-w-sm flex-col gap-3">
      {d.needsPin && d.cashier && <p role="alert" className="text-sm">Enter your PIN to send waiting sales.</p>}
      <fieldset className="grid grid-cols-2 gap-2">
        <legend className="mb-2 text-sm">Who is selling?</legend>
        {staff.map((s) => (
          <label key={s.id} className="flex items-center gap-2 rounded border p-3">
            <input type="radio" name="staffId" value={s.id} checked={staffId === s.id} onChange={() => setStaffId(s.id)} required /> {s.name}
          </label>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1 text-sm">PIN
        <input type="password" inputMode="numeric" pattern="\d{4,6}" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)}
          className="rounded border border-gray-400 px-3 py-2" required />
      </label>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <button type="submit" disabled={busy || !staffId} className={primary}>{busy ? 'Checking…' : 'Start selling'}</button>
    </form>
  );
}

function Selling({ d, slug }: { d: Device; slug: string }) {
  const cache = d.cache!;
  const today = todayIn(cache.shop.timezone, new Date());
  const [lines, setLines] = useState<CartLine[]>([]);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [tenders, setTenders] = useState<Array<{ method: TenderInput['method']; amount: string; reference: string }>>([{ method: 'cash', amount: '', reference: '' }]);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false);
  const priced = useMemo(() => priceCart(cache, lines, today), [cache, lines, today]);
  const hits = useMemo(() => searchCatalogue(cache, query, today), [cache, query, today]);

  if (receipt) return <ReceiptView receipt={receipt} shop={cache.shop.name} register={cache.register.name} onNew={() => setReceipt(null)} />;

  const add = (found: { variantId: string; unitId: string; quantity: string; labelPricePesewas: number | null }) => {
    const problem = canAdd(cache, found);
    if (problem) return setMessage(ADD_ERRORS[problem]);
    setMessage(null);
    setQuery('');
    setLines((ls) => {
      const same = found.labelPricePesewas === null && ls.find((l) => l.variantId === found.variantId && l.unitId === found.unitId && l.labelPricePesewas === null);
      if (!same) return [...ls, { lineId: crypto.randomUUID(), ...found }];
      return ls.map((l) => (l === same ? { ...l, quantity: (Number(l.quantity) + Number(found.quantity)).toFixed(3) } : l));
    });
  };
  const setQty = (lineId: string, value: string) => {
    const q = Number(value);
    if (!(q > 0)) return setLines((ls) => ls.filter((l) => l.lineId !== lineId));
    setLines((ls) => ls.map((l) => (l.lineId === lineId ? { ...l, quantity: q.toFixed(3) } : l)));
  };
  const scan = (e: React.FormEvent) => {
    e.preventDefault();
    const found = findByCode(cache, query);
    if (found) add(found);
    else if (hits.length === 1) add({ variantId: hits[0].variantId, unitId: hits[0].unitId, quantity: '1.000', labelPricePesewas: null });
    else setMessage(hits.length ? 'Pick the item below.' : 'Product not found');
  };
  const pay = async () => {
    const parsed = tenders.map((t) => ({ method: t.method, amountPesewas: parseCedis(t.amount) ?? -1, reference: t.reference }));
    setBusy(true);
    const r = await d.completeSale(priced.lines, priced.totals, parsed);
    setBusy(false);
    if (!r.ok) return setMessage(r.error);
    setReceipt(r.receipt);
    setLines([]);
    setTenders([{ method: 'cash', amount: '', reference: '' }]);
    setMessage(null);
  };

  return (
    <section className="flex flex-col gap-4">
      <form onSubmit={scan} className="flex gap-2">
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Scan a barcode or type a name"
          className="flex-1 rounded border border-gray-400 px-3 py-2" aria-label="Scan or search" />
        <button type="submit" className={btn}>Add</button>
      </form>
      {message && <p role="alert" className="text-sm text-red-700">{message}</p>}
      {query && hits.length > 0 && (
        <ul className="flex flex-col gap-1">
          {hits.map((h) => (
            <li key={h.variantId}>
              <button type="button" className={`${btn} flex w-full items-center gap-3 text-left`}
                onClick={() => add({ variantId: h.variantId, unitId: h.unitId, quantity: '1.000', labelPricePesewas: null })}>
                {h.imageId && <img src={`/api/${slug}/device/images/${h.imageId}`} alt="" className="h-10 w-10 object-cover" />}
                <span className="flex-1">{h.label} ({h.unitName})</span>
                <span>{formatCedis(h.pricePesewas)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <table className="w-full text-sm">
        <tbody>
          {priced.lines.map((l, i) => (
            <tr key={l.lineId} className="border-b">
              <td className="py-2">{l.label} <span className="text-gray-600">({l.unitName})</span></td>
              <td>
                {l.labelPricePesewas === null
                  ? <input type="number" step="any" min="0" value={Number(l.quantity)} onChange={(e) => setQty(l.lineId, e.target.value)} className="w-20 rounded border px-2 py-1" aria-label={`Quantity of ${l.label}`} />
                  : l.quantity}
              </td>
              <td className="text-right">{formatCedis(priced.totals.lines[i].totalPesewas)}</td>
              <td className="text-right"><button type="button" className="px-2 text-red-700" onClick={() => setQty(l.lineId, '0')} aria-label={`Remove ${l.label}`}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="grid grid-cols-2 gap-1 text-sm">
        <dt>Subtotal</dt><dd className="text-right">{formatCedis(priced.totals.subtotalPesewas)}</dd>
        <dt>Tax</dt><dd className="text-right">{formatCedis(priced.totals.taxPesewas)}</dd>
        <dt className="text-lg font-semibold">Total</dt><dd className="text-right text-lg font-semibold">{formatCedis(priced.totals.totalPesewas)}</dd>
      </dl>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm">Payment{d.reachable ? '' : ' (offline: cash and manually confirmed payments only)'}</legend>
        {tenders.map((t, i) => (
          <div key={i} className="flex flex-wrap gap-2">
            <select value={t.method} aria-label="Payment method" className="rounded border px-2 py-2"
              onChange={(e) => setTenders((ts) => ts.map((x, k) => (k === i ? { ...x, method: e.target.value as TenderInput['method'] } : x)))}>
              {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <input inputMode="decimal" placeholder="Amount (GHS)" value={t.amount} aria-label="Amount in cedis" className="w-32 rounded border px-2 py-2"
              onChange={(e) => setTenders((ts) => ts.map((x, k) => (k === i ? { ...x, amount: e.target.value } : x)))} />
            {t.method !== 'cash' && (
              <input placeholder="Reference" value={t.reference} aria-label="Payment reference" className="w-40 rounded border px-2 py-2"
                onChange={(e) => setTenders((ts) => ts.map((x, k) => (k === i ? { ...x, reference: e.target.value } : x)))} />
            )}
          </div>
        ))}
        <button type="button" className={`${btn} self-start text-sm`} onClick={() => setTenders((ts) => [...ts, { method: 'cash', amount: '', reference: '' }])}>Split payment</button>
      </fieldset>
      <button type="button" disabled={busy || priced.lines.length === 0} onClick={pay} className={primary}>{busy ? 'Saving…' : 'Complete sale'}</button>
    </section>
  );
}

function ReceiptView({ receipt, shop, register, onNew }: { receipt: Receipt; shop: string; register: string; onNew: () => void }) {
  return (
    <section className="flex max-w-sm flex-col gap-2 text-sm">
      <h2 className="text-lg font-semibold">{shop}</h2>
      <p>{register} · Receipt {receipt.receiptNumber}</p>
      <p>{receipt.at.toLocaleString()} · Cashier {receipt.cashier}</p>
      {receipt.pending && <p className="rounded bg-amber-100 p-2 font-semibold">Offline – pending sync</p>}
      <ul>
        {receipt.lines.map((l, i) => (
          <li key={l.lineId} className="flex justify-between"><span>{l.label} × {Number(l.quantity)}</span><span>{formatCedis(receipt.totals.lines[i].totalPesewas)}</span></li>
        ))}
      </ul>
      <p className="flex justify-between"><span>Tax</span><span>{formatCedis(receipt.totals.taxPesewas)}</span></p>
      <p className="flex justify-between font-semibold"><span>Total</span><span>{formatCedis(receipt.totals.totalPesewas)}</span></p>
      {receipt.tenders.map((t, i) => (
        <p key={i} className="flex justify-between"><span>{METHODS.find((m) => m.value === t.method)?.label}{t.reference ? ` (${t.reference})` : ''}</span><span>{formatCedis(t.amountPesewas)}</span></p>
      ))}
      <p className="flex justify-between"><span>Change</span><span>{formatCedis(receipt.changeDuePesewas)}</span></p>
      <div className="flex gap-2 print:hidden">
        <button type="button" className={btn} onClick={() => window.print()}>Print</button>
        <button type="button" className={primary} onClick={onNew}>New sale</button>
      </div>
    </section>
  );
}

function Review({ d }: { d: Device }) {
  const held = d.outbox.filter((e) => e.status === 'needs_review');
  if (held.length === 0) return null;
  return (
    <section className="flex flex-col gap-2 text-sm">
      <h2 className="font-semibold">Sales needing manager review</h2>
      {held.map((e) => (
        <div key={e.saleId} className="flex items-center gap-2 rounded border p-2">
          <span className="flex-1">{e.request.receiptNumber} · {formatCedis(e.totalPesewas)} · {(e.lastError ?? '').replaceAll('_', ' ')}</span>
          <button type="button" className={btn} onClick={() => d.retryHeld(e.saleId)}>Try again</button>
        </div>
      ))}
    </section>
  );
}
