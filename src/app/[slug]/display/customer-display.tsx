'use client';
import { useEffect, useState } from 'react';
import { formatCedis } from '@/lib/money';

type State = {
  shopName: string; momoNumber: string | null; promotions: string[];
  cart: { lines: Array<{ name: string; quantity: string; totalPesewas: number }>; discountPesewas: number; totalPesewas: number; paidPesewas: number; changePesewas: number } | null;
};

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode: pair again after a reload */ } };

/** Pairs once with a code from the till, then follows that till's cart every 2 seconds (read-only). */
export function CustomerDisplay({ slug }: { slug: string }) {
  const key = `display-token:${slug}`;
  const [token, setToken] = useState<string | null>(() => (typeof window === 'undefined' ? null : read(key)));
  const [state, setState] = useState<State | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let stop = false;
    const tick = async () => {
      const res = await fetch(`/api/${slug}/display/state`, { headers: { 'x-display-token': token }, cache: 'no-store' }).catch(() => null);
      if (stop) return;
      if (res?.status === 404) { write(key, null); setToken(null); return; } // unpaired or the shop is closed
      if (res?.ok) setState(await res.json());
    };
    const t = setInterval(() => void tick(), 2000);
    void tick();
    return () => { stop = true; clearInterval(t); };
  }, [token, slug, key]);

  if (!token) {
    return (
      <main className="mx-auto my-16 flex max-w-sm flex-col gap-4 p-4 text-center" suppressHydrationWarning>
        <h1 className="text-2xl font-semibold">Customer display</h1>
        <p className="text-sm text-gray-700">On the till, open Customer display and enter the 6-digit code here.</p>
        <form className="flex flex-col gap-2" onSubmit={async (e) => {
          e.preventDefault();
          const r = await fetch(`/api/${slug}/display/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }).then((x) => x.json()).catch(() => null);
          if (r?.ok) { write(key, r.token); setToken(r.token); setError(null); } else setError('That code is wrong or has expired.');
        }}>
          <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} aria-label="Pairing code" className="rounded border border-gray-400 px-3 py-3 text-center text-3xl tracking-widest" />
          <button type="submit" className="rounded bg-blue-800 px-4 py-3 text-white">Connect</button>
          {error && <p role="alert" className="text-red-700">{error}</p>}
        </form>
      </main>
    );
  }
  const cart = state?.cart;
  return (
    <main className="flex min-h-screen flex-col gap-6 bg-gray-950 p-8 text-white">
      <h1 className="text-3xl font-bold">{state?.shopName ?? ''}</h1>
      {cart && cart.lines.length > 0 ? (
        <>
          <ul className="flex-1 divide-y divide-gray-700 text-2xl">{cart.lines.map((l, i) => (
            <li key={i} className="flex justify-between py-2"><span>{l.name} × {Number(l.quantity)}</span><span>{formatCedis(l.totalPesewas)}</span></li>
          ))}</ul>
          {cart.discountPesewas > 0 && <p className="flex justify-between text-2xl text-green-400"><span>You save</span><span>{formatCedis(cart.discountPesewas)}</span></p>}
          <p className="flex justify-between text-5xl font-bold"><span>Total</span><span>{formatCedis(cart.totalPesewas)}</span></p>
          {cart.paidPesewas > 0 && <p className="flex justify-between text-3xl"><span>Change</span><span>{formatCedis(cart.changePesewas)}</span></p>}
          {state?.momoNumber && <p className="text-2xl">Pay by MoMo: <strong>{state.momoNumber}</strong></p>}
        </>
      ) : (
        <section className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <p className="text-4xl">Welcome</p>
          {state?.promotions.map((p) => <p key={p} className="rounded bg-amber-500 px-6 py-3 text-3xl font-semibold text-black">{p}</p>)}
        </section>
      )}
    </main>
  );
}
