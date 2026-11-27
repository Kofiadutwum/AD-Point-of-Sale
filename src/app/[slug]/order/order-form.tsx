'use client';
import { useEffect, useState, useTransition } from 'react';
import { formatCedis } from '@/lib/money';
import { placeOrderAction, requestCodeAction, verifyCodeAction } from './actions';

type Item = { id: string; productId: string; name: string; pricePesewas: number | null; inStock: boolean | null };
type Options = { paystack: boolean; transfer: boolean; deliveryFeePesewas: number };

const input = 'rounded border border-gray-400 px-3 py-2';
type CartLine = { productId: string; name: string; pricePesewas: number; qty: number };
const cartKey = (slug: string) => `order-cart:${slug}`;
const readCart = (slug: string): Record<string, CartLine> => { try { return JSON.parse(sessionStorage.getItem(cartKey(slug)) ?? '{}'); } catch { return {}; } };

/** Spec 6.49: pick items, confirm the phone by SMS code (first order only), choose pickup or delivery, and pay. */
export function OrderForm({ slug, items, options, verifiedPhone, source }: { slug: string; items: Item[]; options: Options; verifiedPhone: string | null; source: string }) {
  // the cart survives searches and page changes (kept in this tab only); loaded after mount so the server render matches
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [loaded, setLoaded] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the browser's saved cart once, after mount
  useEffect(() => { setCart(readCart(slug)); setLoaded(true); }, [slug]);
  useEffect(() => { if (loaded) try { sessionStorage.setItem(cartKey(slug), JSON.stringify(cart)); } catch { /* private mode: the cart lasts until the page changes */ } }, [cart, slug, loaded]);
  const setQty = (i: Item, n: number) => setCart((c) => {
    const next = { ...c };
    if (n > 0) next[i.id] = { productId: i.productId, name: i.name, pricePesewas: i.pricePesewas ?? 0, qty: n }; else delete next[i.id];
    return next;
  });
  const [phone, setPhone] = useState(verifiedPhone ?? '');
  const [verified, setVerified] = useState(!!verifiedPhone);
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [fulfilment, setFulfilment] = useState<'pickup' | 'delivery'>('pickup');
  const [payMethod, setPayMethod] = useState<'paystack' | 'transfer'>(options.paystack ? 'paystack' : 'transfer');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const chosen = Object.entries(cart);
  const total = chosen.reduce((a, [, l]) => a + l.pricePesewas * l.qty, 0);
  const count = chosen.reduce((a, [, l]) => a + l.qty, 0);

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      start(async () => {
        const r = await placeOrderAction(slug, {
          items: chosen.map(([id, l]) => ({ productId: l.productId, variantId: id, quantity: l.qty })), fulfilment, payMethod, source,
          name: String(fd.get('name') ?? ''), address: String(fd.get('address') ?? ''), note: String(fd.get('note') ?? ''),
        });
        if (r.ok) { try { sessionStorage.removeItem(cartKey(slug)); } catch { /* fine */ } window.location.assign(r.next); } else setError(r.error);
      });
    }}>
      <ul className="divide-y">{items.map((i) => (
        <li key={i.id} className="flex items-center justify-between gap-2 py-2">
          <span>{i.name}<br /><span className="text-sm text-gray-600">{i.pricePesewas != null ? formatCedis(i.pricePesewas) : ''}{i.inStock === false ? ' · out of stock' : ''}</span></span>
          <input type="number" min={0} max={99} value={cart[i.id]?.qty ?? 0} disabled={i.inStock === false} aria-label={`How many ${i.name}`}
            onChange={(e) => setQty(i, Math.max(0, Math.min(99, Number(e.target.value) || 0)))} className={`${input} w-20`} />
        </li>
      ))}</ul>
      {count > 0 && (
        <a href="#checkout" className="sticky bottom-2 z-10 flex justify-between rounded px-4 py-3 font-semibold text-white shadow" style={{ background: 'var(--brand)' }}>
          <span>{count} item{count === 1 ? '' : 's'} · {formatCedis(total)}</span><span>Checkout ↓</span>
        </a>
      )}
      <section id="checkout" className="flex flex-col gap-1 rounded border p-3">
        <h2 className="font-semibold">Your order</h2>
        {chosen.length === 0 ? <p className="text-sm text-gray-600">Nothing yet: set how many you want above.</p> : (
          <ul className="text-sm">{chosen.map(([id, l]) => (
            <li key={id} className="flex justify-between gap-2"><span>{l.qty} × {l.name}</span><span>{formatCedis(l.pricePesewas * l.qty)} <button type="button" className="underline" onClick={() => setCart((c) => { const n = { ...c }; delete n[id]; return n; })}>remove</button></span></li>
          ))}</ul>
        )}
      </section>
      <p className="text-lg font-semibold">Items: {formatCedis(total)}{fulfilment === 'delivery' && options.deliveryFeePesewas > 0 ? ` + ${formatCedis(options.deliveryFeePesewas)} delivery, paid on delivery` : ''}</p>

      <fieldset className="flex flex-col gap-2">
        <legend className="font-semibold">Your phone</legend>
        {verified ? <p className="text-sm">Confirmed: {phone}</p> : (
          <div className="flex flex-wrap gap-2">
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="024 123 4567" aria-label="Phone number" className={input} />
            <button type="button" disabled={pending} className="rounded border px-3 py-2" onClick={() => start(async () => {
              const r = await requestCodeAction(slug, phone);
              if (r.ok) { setVerificationId(r.verificationId); setError(null); } else setError(r.error);
            })}>Send code</button>
            {verificationId && <>
              <input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" aria-label="Code from SMS" className={`${input} w-32`} />
              <button type="button" disabled={pending} className="rounded border px-3 py-2" onClick={() => start(async () => {
                const r = await verifyCodeAction(slug, verificationId, code);
                if (r.ok) { setVerified(true); setPhone(r.phone); setError(null); } else setError(r.error);
              })}>Confirm</button>
            </>}
          </div>
        )}
      </fieldset>

      <label className="flex flex-col gap-1 text-sm">Your name<input name="name" required maxLength={80} className={input} /></label>
      <fieldset className="flex gap-4 text-sm">
        <label className="flex items-center gap-1"><input type="radio" checked={fulfilment === 'pickup'} onChange={() => setFulfilment('pickup')} />Pick up</label>
        <label className="flex items-center gap-1"><input type="radio" checked={fulfilment === 'delivery'} onChange={() => setFulfilment('delivery')} />Deliver</label>
      </fieldset>
      {fulfilment === 'delivery' && <label className="flex flex-col gap-1 text-sm">Delivery address<textarea name="address" required maxLength={300} rows={2} className={input} /></label>}
      <label className="flex flex-col gap-1 text-sm">Note for the shop (optional)<input name="note" maxLength={300} className={input} /></label>
      <fieldset className="flex gap-4 text-sm">
        {options.paystack && <label className="flex items-center gap-1"><input type="radio" checked={payMethod === 'paystack'} onChange={() => setPayMethod('paystack')} />Pay now (card or MoMo)</label>}
        {options.transfer && <label className="flex items-center gap-1"><input type="radio" checked={payMethod === 'transfer'} onChange={() => setPayMethod('transfer')} />Bank or MoMo transfer</label>}
      </fieldset>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      <button type="submit" disabled={pending || !verified || !chosen.length} className="rounded px-4 py-3 font-semibold text-white disabled:opacity-50" style={{ background: 'var(--brand)' }}>
        {pending ? 'Please wait…' : `Place order · ${formatCedis(total)}`}
      </button>
    </form>
  );
}
