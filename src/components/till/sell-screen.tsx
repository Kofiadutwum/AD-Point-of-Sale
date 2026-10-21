'use client';
import { useCallback, useRef, useState } from 'react';
import { findCustomersAction, findItemAction, priceItemAction } from '@/app/[slug]/app/sell/actions';
import { calculateCartTotals } from '@/lib/cart-totals';
import { formatCedis, parseCedis } from '@/lib/money';
import { formatReceiptNumber } from '@/lib/receipt';
import type { Customer } from '@/server/customers';
import type { CatalogueHit } from '@/server/products';
import type { TillItem, TillRegister } from '@/server/till';
import { CameraScanner } from './camera-scanner';

type Line = TillItem & { discountPesewas: number; serials: string };
type OtherMethod = 'momo_manual' | 'card_terminal' | 'bank_transfer' | 'store_credit';

const ERRORS: Record<string, string> = {
  price_changed: 'A price changed. Remove the item and scan it again.', item_unavailable: 'An item is no longer sold.',
  not_enough_stock: 'Not enough stock for this sale.', only_expired_stock: 'Only expired stock is left for an item.',
  serials_required: 'Enter one serial number per unit for serial items.', unknown_serial: 'A serial number is not in stock here.',
  reference_required: 'Enter the payment reference (MoMo ID, slip or transfer number).', reduce_non_cash_amount: 'Only cash can be more than the total.',
  payment_incomplete: 'The payments do not cover the total.', insufficient_store_credit: 'Not enough store credit.',
  store_credit_needs_customer: 'Choose the customer to use store credit.', discount_not_allowed: 'You cannot give discounts.',
  discount_too_large: 'A discount is larger than the line amount.', invalid_quantity: 'Check the quantities.', empty_bundle: 'A bundle has no parts set up.',
};

const qtyText = (q: string) => q.replace(/\.?0+$/, '');

function readCounter(key: string): number {
  try { return Number(localStorage.getItem(key) ?? 0) || 0; } catch { return 0; }
}
function writeCounter(key: string, n: number) {
  try { localStorage.setItem(key, String(n)); } catch { /* private mode: the server counter still protects uniqueness */ }
}

export function SellScreen({ slug, till, canDiscount, taxMode }: { slug: string; till: TillRegister; canDiscount: boolean; taxMode: 'inclusive' | 'exclusive' }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [code, setCode] = useState('');
  const [hits, setHits] = useState<CatalogueHit[]>([]);
  const [camera, setCamera] = useState(false);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerHits, setCustomerHits] = useState<Customer[]>([]);
  const [cash, setCash] = useState('');
  const [other, setOther] = useState<{ method: OtherMethod; amount: string; reference: string }>({ method: 'momo_manual', amount: '', reference: '' });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ saleId: string; change: number; receiptNumber: string; total: number } | null>(null);
  const saleId = useRef<string | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const counterKey = `receipt-counter:${till.registerId}`;

  const add = useCallback((item: TillItem) => {
    if (!item.available) { setMessage(`${item.name} is no longer sold.`); return; }
    setLines((ls) => {
      const same = ls.findIndex((l) => l.variantId === item.variantId && l.unitId === item.unitId && item.quantity === '1.000' && !item.fractions);
      if (same >= 0) { // scanning the same item again adds one (spec 6.5)
        const next = [...ls];
        next[same] = { ...next[same], quantity: (Number(next[same].quantity) + 1).toFixed(3) };
        return next;
      }
      return [...ls, { ...item, discountPesewas: 0, serials: '' }];
    });
    setHits([]);
    setMessage(null);
  }, []);

  const find = useCallback(async (text: string) => {
    if (!text.trim()) return;
    const r = await findItemAction(slug, { code: text, branchId: till.branchId, customerId: customer?.id ?? null });
    if (r.item) add(r.item);
    else if (r.hits.length) setHits(r.hits);
    else setMessage('Product not found.');
    setCode('');
    codeInput.current?.focus();
  }, [slug, till.branchId, customer, add]);

  const onCamera = useCallback((c: string) => { setCamera(false); void find(c); }, [find]);

  async function changeQuantity(i: number, quantity: string) {
    const l = lines[i];
    const priced = await priceItemAction(slug, { variantId: l.variantId, unitId: l.unitId, quantity, branchId: till.branchId, customerId: customer?.id ?? null });
    if (!priced) { setMessage('Enter a valid quantity.'); return; }
    setLines((ls) => ls.map((x, j) => (j === i ? { ...x, quantity: priced.quantity, unitPricePesewas: priced.unitPricePesewas } : x)));
  }

  let totals: ReturnType<typeof calculateCartTotals> | null = null;
  try {
    totals = calculateCartTotals(lines, { taxMode });
  } catch {
    totals = null; // a discount above its line; shown as an error below
  }
  const cashPesewas = cash.trim() ? parseCedis(cash) : 0;
  const otherPesewas = other.amount.trim() ? parseCedis(other.amount) : 0;
  const paid = (cashPesewas ?? 0) + (otherPesewas ?? 0);
  const change = totals ? Math.max(0, paid - totals.totalPesewas) : 0;

  async function complete() {
    if (!totals || cashPesewas === null || otherPesewas === null) { setMessage('Check the amounts.'); return; }
    setBusy(true);
    setMessage(null);
    saleId.current ??= crypto.randomUUID(); // kept until success, so a retry is the same sale
    const tenders = [
      ...(cashPesewas ? [{ id: crypto.randomUUID(), method: 'cash' as const, amountPesewas: cashPesewas }] : []),
      ...(otherPesewas ? [{ id: crypto.randomUUID(), method: other.method, amountPesewas: otherPesewas, reference: other.reference.trim() || undefined }] : []),
    ];
    let counter = Math.max(readCounter(counterKey), till.lastCounter) + 1;
    for (let attempt = 0; attempt < 2; attempt++) {
      const receiptNumber = formatReceiptNumber(till.branchCode, till.registerCode, counter);
      const res = await fetch(`/api/${slug}/sales`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          saleId: saleId.current, receiptNumber, tenders, customerId: customer?.id, deviceCreatedAt: new Date().toISOString(),
          lines: lines.map((l) => ({
            variantId: l.variantId, unitId: l.unitId, quantity: l.quantity, unitPricePesewas: l.unitPricePesewas, discountPesewas: l.discountPesewas,
            ...(l.tracking === 'serial' ? { serials: l.serials.split(/[\s,]+/).filter(Boolean) } : {}),
          })),
        }),
      });
      const r = await res.json().catch(() => ({ ok: false, error: 'network' }));
      if (r.ok) {
        writeCounter(counterKey, counter);
        setDone({ saleId: r.saleId, change: r.changeDuePesewas, receiptNumber, total: totals.totalPesewas });
        setBusy(false);
        return;
      }
      if (r.error === 'duplicate_receipt_number') { writeCounter(counterKey, counter); counter += 1; continue; }
      setMessage(ERRORS[r.error] ?? 'The sale could not be completed. Try again.');
      break;
    }
    setBusy(false);
  }

  function newSale() {
    setLines([]); setCustomer(null); setCash(''); setOther({ method: 'momo_manual', amount: '', reference: '' });
    setDone(null); saleId.current = null; setMessage(null);
    setTimeout(() => codeInput.current?.focus(), 0);
  }

  if (done) {
    return (
      <main className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Sale complete</h1>
        <p className="text-lg">Receipt {done.receiptNumber} · Total {formatCedis(done.total)}</p>
        <p className="text-3xl font-bold" role="status">Change: {formatCedis(done.change)}</p>
        <nav className="flex flex-wrap gap-3">
          <a href={`/${slug}/app/receipts/${done.saleId}?w=80`} className="rounded border px-4 py-2">Print 80 mm</a>
          <a href={`/${slug}/app/receipts/${done.saleId}?w=58`} className="rounded border px-4 py-2">Print 58 mm</a>
          <a href={`/${slug}/app/receipts/${done.saleId}`} className="rounded border px-4 py-2">Share on WhatsApp</a>
          <button type="button" onClick={newSale} autoFocus className="rounded bg-blue-800 px-4 py-2 text-white">New sale</button>
        </nav>
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
        <span className="text-sm text-gray-700">Till {till.branchCode}-{till.registerCode}</span>
      </header>
      <form onSubmit={(e) => { e.preventDefault(); void find(code); }} className="flex gap-2">
        <input ref={codeInput} autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="Scan a barcode or type a name"
          aria-label="Barcode or search" className="min-w-0 flex-1 rounded border border-gray-400 px-3 py-2" />
        <button type="submit" className="rounded border px-4 py-2">Add</button>
        <button type="button" onClick={() => setCamera((c) => !c)} className="rounded border px-4 py-2">Camera</button>
      </form>
      {camera && <CameraScanner onCode={onCamera} onClose={() => setCamera(false)} />}
      {hits.length > 0 && (
        <ul className="divide-y rounded border">
          {hits.map((h) => (
            <li key={h.variantId}>
              <button type="button" className="flex w-full justify-between p-2 text-left hover:bg-gray-50" onClick={async () => {
                const item = await priceItemAction(slug, { variantId: h.variantId, quantity: '1', branchId: till.branchId, customerId: customer?.id ?? null });
                if (item) add(item);
              }}>
                <span>{h.productName}{h.variantName ? ` – ${h.variantName}` : ''}</span><span>{formatCedis(h.basePricePesewas)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {message && <p role="alert" className="text-sm text-red-700">{message}</p>}

      <ul className="divide-y rounded border">
        {lines.map((l, i) => (
          <li key={`${l.variantId}-${l.unitId}-${i}`} className="flex flex-col gap-1 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="flex-1">{l.name} <span className="text-xs text-gray-600">({l.unitName})</span></span>
              <input aria-label={`Quantity of ${l.name}`} defaultValue={qtyText(l.quantity)} key={l.quantity} inputMode="decimal"
                onBlur={(e) => { if (e.target.value !== qtyText(l.quantity)) void changeQuantity(i, e.target.value); }}
                className="w-20 rounded border border-gray-400 px-2 py-1 text-right" />
              <span className="w-24 text-right">{totals ? formatCedis(totals.lines[i].totalPesewas) : '—'}</span>
              <button type="button" aria-label={`Remove ${l.name}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} className="px-2 text-red-700">×</button>
            </div>
            {canDiscount && (
              <label className="flex items-center gap-2 text-xs">Discount (GHS)
                <input inputMode="decimal" className="w-20 rounded border border-gray-400 px-2 py-1" onChange={(e) => {
                  const d = e.target.value.trim() ? parseCedis(e.target.value) : 0;
                  setLines((ls) => ls.map((x, j) => (j === i ? { ...x, discountPesewas: d ?? 0 } : x)));
                }} />
              </label>
            )}
            {l.tracking === 'serial' && (
              <input aria-label={`Serial numbers for ${l.name}`} placeholder="Serial or IMEI, one per unit" value={l.serials}
                onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, serials: e.target.value } : x)))}
                className="rounded border border-gray-400 px-2 py-1 text-xs" />
            )}
          </li>
        ))}
        {lines.length === 0 && <li className="p-3 text-sm text-gray-600">Scan or search to add items.</li>}
      </ul>

      {totals ? (
        <section className="flex flex-col gap-1 text-sm">
          <p className="flex justify-between"><span>Subtotal</span><span>{formatCedis(totals.subtotalPesewas)}</span></p>
          {totals.discountPesewas > 0 && <p className="flex justify-between"><span>Discounts</span><span>−{formatCedis(totals.discountPesewas)}</span></p>}
          <p className="flex justify-between"><span>{taxMode === 'inclusive' ? 'Tax included' : 'Tax'}</span><span>{formatCedis(totals.taxPesewas)}</span></p>
          <p className="flex justify-between text-xl font-bold"><span>Total</span><span>{formatCedis(totals.totalPesewas)}</span></p>
        </section>
      ) : <p role="alert" className="text-sm text-red-700">A discount is larger than its line amount.</p>}

      <section className="flex flex-col gap-2">
        <div className="flex gap-2">
          <input value={customerQuery} onChange={(e) => setCustomerQuery(e.target.value)} placeholder="Customer phone or name (optional)"
            aria-label="Customer" className="min-w-0 flex-1 rounded border border-gray-400 px-3 py-2" />
          <button type="button" className="rounded border px-3" onClick={async () => setCustomerHits(await findCustomersAction(slug, customerQuery))}>Find</button>
        </div>
        {customer && <p className="text-sm">Customer: {customer.name} · store credit {formatCedis(customer.storeCreditPesewas)} <button type="button" className="text-blue-800 underline" onClick={() => setCustomer(null)}>remove</button></p>}
        {customerHits.map((c) => (
          <button key={c.id} type="button" className="text-left text-sm text-blue-800 underline" onClick={() => { setCustomer(c); setCustomerHits([]); }}>{c.name} · {c.phone}</button>
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-sm">Cash received (GHS)
          <input value={cash} onChange={(e) => setCash(e.target.value)} inputMode="decimal" className="rounded border border-gray-400 px-3 py-2" />
        </label>
        <div className="flex flex-wrap gap-2 text-sm">
          <select aria-label="Other payment" value={other.method} onChange={(e) => setOther({ ...other, method: e.target.value as OtherMethod })} className="rounded border border-gray-400 px-2 py-2">
            <option value="momo_manual">Mobile money</option>
            <option value="card_terminal">Card</option>
            <option value="bank_transfer">Bank transfer</option>
            {customer && <option value="store_credit">Store credit</option>}
          </select>
          <input aria-label="Other payment amount" placeholder="Amount (GHS)" value={other.amount} onChange={(e) => setOther({ ...other, amount: e.target.value })} inputMode="decimal" className="w-28 rounded border border-gray-400 px-2 py-2" />
          {other.method !== 'store_credit' && (
            <input aria-label="Payment reference" placeholder="Reference" value={other.reference} onChange={(e) => setOther({ ...other, reference: e.target.value })} className="min-w-0 flex-1 rounded border border-gray-400 px-2 py-2" />
          )}
        </div>
        {totals && paid > 0 && <p className="text-lg">Change due: <strong>{formatCedis(change)}</strong></p>}
        <button type="button" disabled={busy || lines.length === 0 || !totals} onClick={() => void complete()}
          className="rounded bg-green-700 px-4 py-3 text-lg text-white disabled:opacity-50">{busy ? 'Please wait…' : 'Complete sale'}</button>
      </section>
    </main>
  );
}
