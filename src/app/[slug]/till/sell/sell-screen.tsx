'use client';
import { useMemo, useState } from 'react';
import { canAdd, type CartLine, comboSlotsOf, findByCode, priceCart, searchCatalogue, withPackLine } from '@/device/catalogue';
import type { TenderInput } from '@/device/sale';
import { businessDate, todayIn } from '@/lib/dates';
import type { ComboChoice, DiningOption } from '@/lib/food';
import { formatCedis, parseCedis } from '@/lib/money';
import { type CollectableOrder, createPhoneOrderAction, findPhoneOrderAction, markAvailableAction, markSoldOutAction } from '../actions';
import { type FoodChoice, type Receipt, useDevice } from './use-device';

const DINING: Array<{ value: DiningOption; label: string }> = [{ value: 'eat_in', label: 'Eat in' }, { value: 'takeaway', label: 'Takeaway' }, { value: 'delivery', label: 'Delivery' }];
const MODE_LABELS = { counter: 'Counter', quick: 'Quick serve' } as const;

const METHODS: Array<{ value: TenderInput['method']; label: string }> = [
  { value: 'cash', label: 'Cash' }, { value: 'momo_manual', label: 'MoMo' }, { value: 'card_terminal', label: 'Card' }, { value: 'bank_transfer', label: 'Bank' },
];
const ADD_ERRORS = {
  unavailable: 'Product unavailable', serial_item: 'Sell serial items on the online sell page.', invalid_quantity: 'Enter a valid quantity', sold_out: 'Sold out today',
  amount_required: 'Type the amount to sell', below_minimum_amount: 'Below the minimum amount', invalid_choices: 'Pick the combo choices first',
} as const;
const EMPTY_ORDER = { externalOrderId: '', name: '', phone: '', pickup: '', address: '' };
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
  const day = businessDate(cache.shop.timezone, cache.shop.businessDayCutoff, new Date());
  const modes = cache.food?.serviceModes ?? [];
  const [lines, setLines] = useState<CartLine[]>([]);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [tenders, setTenders] = useState<Array<{ method: TenderInput['method']; amount: string; reference: string }>>([{ method: 'cash', amount: '', reference: '' }]);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [modeChoice, setModeChoice] = useState<'counter' | 'quick' | null>(() => {
    try { return sessionStorage.getItem(`pos-mode-${slug}`) as 'counter' | 'quick' | null; } catch { return null; }
  });
  const [dining, setDining] = useState<DiningOption>('eat_in');
  const mode = modeChoice && modes.includes(modeChoice) ? modeChoice : (modes[0] ?? null);
  const pickMode = (m: 'counter' | 'quick') => {
    setModeChoice(m);
    try { sessionStorage.setItem(`pos-mode-${slug}`, m); } catch { /* private mode: falls back to the first mode */ }
  };
  // the pack line follows the cart and the dining option (spec 6.56); quick serve is always eat in
  const staffPermissions = cache.staff.find((s) => s.id === d.cashier?.staffId)?.permissions ?? [];
  // spec 6.57: delivery apps, phone, and WhatsApp are counter orders with their own prices
  const channels = cache.food && staffPermissions.includes('enter_channel_orders') ? cache.channels : [];
  const [channelId, setChannelId] = useState('');
  const channel = mode === 'counter' ? channels.find((c) => c.id === channelId) ?? null : null;
  const appCollects = channel?.kind === 'delivery_app' && channel.collectedBy === 'app';
  const [order, setOrder] = useState(EMPTY_ORDER);
  const [collecting, setCollecting] = useState<(CollectableOrder & { orderNumber: string }) | null>(null);
  const [collectNumber, setCollectNumber] = useState('');
  const [slip, setSlip] = useState<{ orderNumber: string; lines: Array<{ lineId: string; label: string; quantity: string }> } | null>(null);
  const cart = useMemo(() => (mode ? withPackLine(cache, lines, mode === 'quick' ? 'eat_in' : dining) : lines), [cache, lines, mode, dining]);
  const priced = useMemo(() => priceCart(cache, cart, today, { priceListId: channel?.priceListId ?? null }), [cache, cart, today, channel]);
  const hits = useMemo(() => searchCatalogue(cache, query, today), [cache, query, today]);
  const soldOutToday = (variantId: string) => cache.food?.businessDate === day && cache.food.soldOutVariantIds.includes(variantId);
  // a by-amount item opens the amount pad; a combo walks through its slots (spec 6.52, 6.53)
  const [pending, setPending] = useState<{ variantId: string; unitId: string; mode: 'amount' | 'combo' } | null>(null);

  if (receipt) return <ReceiptView receipt={receipt} shop={cache.shop.name} register={cache.register.name} onNew={() => setReceipt(null)} />;
  if (slip) return <PhoneSlip slip={slip} customer={order.name} onNew={() => { setSlip(null); setOrder(EMPTY_ORDER); setChannelId(''); }} />;

  const resetChannel = () => { setChannelId(''); setOrder(EMPTY_ORDER); setCollecting(null); setCollectNumber(''); };
  const pickChannel = (id: string) => {
    setChannelId(id);
    if (id && dining === 'eat_in') setDining('takeaway'); // channel orders are takeaway or delivery
  };
  // shortcut: a pickup time is read as Ghana time (UTC+0); use the shop timezone when other countries join
  const pickupAt = order.pickup ? `${day}T${order.pickup}:00Z` : undefined;
  const channelFood = (): Partial<FoodChoice> => {
    if (!channel) return {};
    if (collecting) return { channelId: channel.id, kitchenOrderId: collecting.kitchenOrderId };
    if (channel.kind === 'delivery_app') return { channelId: channel.id, externalOrderId: order.externalOrderId.trim() };
    return {
      channelId: channel.id, customer: { name: order.name, phone: order.phone },
      ...(pickupAt ? { pickupAt } : {}), ...(order.address.trim() ? { deliveryAddress: order.address.trim() } : {}),
    };
  };
  const payLater = async () => {
    if (!channel || channel.kind === 'delivery_app') return;
    if (!d.reachable) return setMessage('Connect to the internet to send an unpaid order.');
    setBusy(true);
    const r = await createPhoneOrderAction(slug, {
      channelId: channel.id, diningOption: dining === 'delivery' ? 'delivery' : 'takeaway', customer: { name: order.name, phone: order.phone },
      ...(pickupAt ? { pickupAt } : {}), ...(order.address.trim() ? { deliveryAddress: order.address.trim() } : {}),
      lines: lines.filter((l) => l.variantId !== cache.food?.packVariantId).map((l) => ({
        variantId: l.variantId, unitId: l.unitId, quantity: l.quantity,
        ...(l.amountPesewas != null ? { byAmount: true, amountPesewas: l.amountPesewas } : {}), ...(l.choices?.length ? { choices: l.choices } : {}),
      })),
    });
    setBusy(false);
    if (!r.ok) return setMessage(r.error);
    setSlip({ orderNumber: r.orderNumber, lines: priced.lines.filter((l) => l.lineId !== 'pack') });
    setLines([]);
    setMessage(null);
  };
  const collect = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await findPhoneOrderAction(slug, collectNumber.trim());
    if (!r.ok) return setMessage(r.error);
    if (!channels.some((c) => c.id === r.order.channelId)) return setMessage('That order’s channel is no longer in use.');
    setCollecting({ ...r.order, orderNumber: collectNumber.trim() });
    setChannelId(r.order.channelId);
    setDining(r.order.diningOption);
    // the order's lines, locked: the cashier takes payment for exactly what was ordered, at today's prices
    setLines(r.order.lines.map((p) => ({
      lineId: crypto.randomUUID(), variantId: p.variantId, unitId: p.unitId, quantity: p.quantity, labelPricePesewas: null,
      amountPesewas: p.byAmount ? p.amountPesewas ?? null : null, ...(p.choices?.length ? { choices: p.choices } : {}),
    })));
    setMessage(null);
  };

  const toggleSoldOut = async (variantId: string) => {
    if (!d.reachable) return setMessage('Connect to the internet to mark sold out');
    const r = soldOutToday(variantId) ? await markAvailableAction(slug, variantId) : await markSoldOutAction(slug, variantId);
    if (!r.ok) return setMessage(r.error);
    setMessage(null);
    await d.refresh();
  };

  const add = (found: { variantId: string; unitId: string; quantity: string; labelPricePesewas: number | null; amountPesewas?: number | null; choices?: ComboChoice[] }) => {
    const variant = cache.variants.find((v) => v.id === found.variantId);
    if (variant?.sellByAmount && found.amountPesewas == null && !soldOutToday(found.variantId)) return setPending({ variantId: found.variantId, unitId: found.unitId, mode: 'amount' });
    if (variant?.kind === 'combo' && !found.choices && !soldOutToday(found.variantId)) return setPending({ variantId: found.variantId, unitId: found.unitId, mode: 'combo' });
    const problem = canAdd(cache, found, day);
    if (problem) return setMessage(ADD_ERRORS[problem]);
    setMessage(null);
    setQuery('');
    setPending(null);
    setLines((ls) => {
      const plain = found.labelPricePesewas === null && found.amountPesewas == null && !found.choices;
      const same = plain && ls.find((l) => l.variantId === found.variantId && l.unitId === found.unitId && l.labelPricePesewas === null && l.amountPesewas == null && !l.choices);
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
    if (channel?.kind === 'delivery_app' && !order.externalOrderId.trim()) return setMessage('Enter the app order ID.');
    // an app that collects the money pays later: one settlement for the total, its reference the platform order ID (spec 6.57)
    const parsed: TenderInput[] = appCollects
      ? [{ method: 'channel_settlement', amountPesewas: priced.totals.totalPesewas, reference: order.externalOrderId.trim() }]
      : tenders.map((t) => ({ method: t.method, amountPesewas: parseCedis(t.amount) ?? -1, reference: t.reference }));
    setBusy(true);
    const r = await d.completeSale(priced.lines, priced.totals, parsed, mode ? { serviceMode: mode, diningOption: dining, ...channelFood() } : undefined);
    setBusy(false);
    if (!r.ok) return setMessage(r.error);
    setReceipt(r.receipt);
    setLines([]);
    setDining('eat_in');
    setTenders([{ method: 'cash', amount: '', reference: '' }]);
    resetChannel();
    setMessage(null);
  };

  return (
    <section className="flex flex-col gap-4">
      {mode && (
        <div className="flex flex-wrap items-center gap-2">
          {modes.length > 1 && (
            <div role="group" aria-label="Service mode" className="flex gap-1">
              {modes.map((m) => (
                <button key={m} type="button" aria-pressed={mode === m} onClick={() => pickMode(m)}
                  className={`${btn} ${mode === m ? 'bg-blue-800 text-white' : ''}`}>{MODE_LABELS[m]}</button>
              ))}
            </div>
          )}
          {mode === 'counter' && (
            <div role="group" aria-label="Dining option" className="flex gap-1">
              {DINING.filter((o) => !channel || o.value !== 'eat_in').map((o) => (
                <button key={o.value} type="button" aria-pressed={dining === o.value} disabled={!!collecting} onClick={() => setDining(o.value)}
                  className={`${btn} ${dining === o.value ? 'bg-gray-900 text-white' : ''}`}>{o.label}</button>
              ))}
            </div>
          )}
          {mode === 'counter' && channels.length > 0 && (
            <label className="flex items-center gap-1 text-sm">Channel
              <select value={channelId} disabled={!!collecting} onChange={(e) => pickChannel(e.target.value)} className="rounded border px-2 py-2">
                <option value="">Walk-in</option>
                {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          {d.reachable && staffPermissions.includes('run_kitchen') && <a href={`/${slug}/app/kitchen`} className="ml-auto text-sm text-blue-800 underline">Kitchen</a>}
        </div>
      )}
      {pending?.mode === 'amount' && (
        <AmountPad min={cache.variants.find((v) => v.id === pending.variantId)?.minAmountPesewas ?? 0} onCancel={() => setPending(null)}
          onAdd={(amountPesewas) => add({ variantId: pending.variantId, unitId: pending.unitId, quantity: '1.000', labelPricePesewas: null, amountPesewas })} />
      )}
      {pending?.mode === 'combo' && (
        <ComboPicker key={pending.variantId} slots={comboSlotsOf(cache, pending.variantId)} hidden={(id) => soldOutToday(id)} onCancel={() => setPending(null)}
          onAdd={(choices) => add({ variantId: pending.variantId, unitId: pending.unitId, quantity: '1.000', labelPricePesewas: null, choices })} />
      )}
      {mode === 'counter' && !collecting && channels.some((c) => c.kind !== 'delivery_app') && (
        <form onSubmit={collect} className="flex gap-2 text-sm">
          <input value={collectNumber} onChange={(e) => setCollectNumber(e.target.value)} placeholder="Order number" aria-label="Phone order number" className="w-32 rounded border px-2 py-2" />
          <button type="submit" className={btn} disabled={!collectNumber.trim() || !d.reachable}>Collect phone order</button>
        </form>
      )}
      {collecting && (
        <p role="status" className="flex items-center gap-2 rounded bg-blue-50 p-2 text-sm">
          <span className="flex-1">Collecting order {collecting.orderNumber} for {collecting.customerName}. Items cannot be changed.</span>
          <button type="button" className={btn} onClick={() => { resetChannel(); setLines([]); }}>Cancel</button>
        </p>
      )}
      {channel && !collecting && (channel.kind === 'delivery_app' ? (
        <input value={order.externalOrderId} onChange={(e) => setOrder({ ...order, externalOrderId: e.target.value })} maxLength={64} required
          placeholder={`${channel.name} order ID`} aria-label="App order ID" className="rounded border border-gray-400 px-3 py-2" />
      ) : (
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <input value={order.name} onChange={(e) => setOrder({ ...order, name: e.target.value })} maxLength={80} placeholder="Customer name" aria-label="Customer name" className="rounded border px-2 py-2" />
          <input value={order.phone} onChange={(e) => setOrder({ ...order, phone: e.target.value })} inputMode="tel" placeholder="Phone, e.g. 024 123 4567" aria-label="Customer phone" className="rounded border px-2 py-2" />
          <label className="flex items-center gap-2">Pickup time<input type="time" value={order.pickup} onChange={(e) => setOrder({ ...order, pickup: e.target.value })} className="rounded border px-2 py-2" /></label>
          <input value={order.address} onChange={(e) => setOrder({ ...order, address: e.target.value })} maxLength={200} placeholder="Or delivery address / GhanaPostGPS" aria-label="Delivery address" className="rounded border px-2 py-2" />
        </div>
      ))}
      {!collecting && (
        <form onSubmit={scan} className="flex gap-2">
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Scan a barcode or type a name"
            className="flex-1 rounded border border-gray-400 px-3 py-2" aria-label="Scan or search" />
          <button type="submit" className={btn}>Add</button>
        </form>
      )}
      {message && <p role="alert" className="text-sm text-red-700">{message}</p>}
      {query && hits.length > 0 && (
        <ul className={mode === 'quick' ? 'grid grid-cols-2 gap-2' : 'flex flex-col gap-1'}>
          {hits.map((h) => {
            const out = soldOutToday(h.variantId);
            return (
              <li key={h.variantId} className="flex gap-1">
                <button type="button" aria-disabled={out} className={`${btn} flex flex-1 items-center gap-3 text-left ${mode === 'quick' ? 'min-h-16 text-base' : ''} ${out ? 'opacity-50' : ''}`}
                  onClick={() => add({ variantId: h.variantId, unitId: h.unitId, quantity: '1.000', labelPricePesewas: null })}>
                  {h.imageId && <img src={`/api/${slug}/device/images/${h.imageId}`} alt="" className="h-10 w-10 object-cover" />}
                  <span className="flex-1">{h.label} ({h.unitName}){out && <span className="block text-xs text-red-700">Sold out today</span>}</span>
                  <span>{formatCedis(h.pricePesewas)}</span>
                </button>
                {cache.food && staffPermissions.includes('mark_sold_out') && (
                  <button type="button" className={`${btn} text-xs`} onClick={() => toggleSoldOut(h.variantId)}>{out ? 'Available' : 'Sold out'}</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <table className="w-full text-sm">
        <tbody>
          {priced.lines.map((l, i) => (
            <tr key={l.lineId} className="border-b">
              <td className="py-2">{l.label} <span className="text-gray-600">({l.unitName})</span></td>
              <td>
                {l.labelPricePesewas === null && l.lineId !== 'pack' && l.amountPesewas == null && !collecting
                  ? <input type="number" step="any" min="0" value={Number(l.quantity)} onChange={(e) => setQty(l.lineId, e.target.value)} className="w-20 rounded border px-2 py-1" aria-label={`Quantity of ${l.label}`} />
                  : l.quantity}
              </td>
              <td className="text-right">{formatCedis(priced.totals.lines[i].totalPesewas)}</td>
              <td className="text-right">
                {l.lineId !== 'pack' && !collecting && <button type="button" className="px-2 text-red-700" onClick={() => setQty(l.lineId, '0')} aria-label={`Remove ${l.label}`}>✕</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="grid grid-cols-2 gap-1 text-sm">
        <dt>Subtotal</dt><dd className="text-right">{formatCedis(priced.totals.subtotalPesewas)}</dd>
        <dt>Tax</dt><dd className="text-right">{formatCedis(priced.totals.taxPesewas)}</dd>
        <dt className="text-lg font-semibold">Total</dt><dd className="text-right text-lg font-semibold">{formatCedis(priced.totals.totalPesewas)}</dd>
      </dl>
      {appCollects ? <p className="text-sm">Paid by the app: {channel!.name} pays the shop later.</p> : (
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
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || priced.lines.length === 0} onClick={pay} className={primary}>{busy ? 'Saving…' : appCollects ? 'Send order' : 'Complete sale'}</button>
        {channel && channel.kind !== 'delivery_app' && !collecting && (
          <button type="button" disabled={busy || lines.length === 0 || !d.reachable} onClick={payLater} className={btn}>Pay on collection</button>
        )}
      </div>
    </section>
  );
}

const QUICK_AMOUNTS = [500, 1000, 1500, 2000];

/** Spec 6.53: the cashier types or taps the cedi amount; below the minimum is shown before it reaches the cart. */
function AmountPad({ min, onAdd, onCancel }: { min: number; onAdd: (amountPesewas: number) => void; onCancel: () => void }) {
  const [text, setText] = useState('');
  const amount = parseCedis(text);
  const below = amount !== null && amount < min;
  return (
    <div role="dialog" aria-label="Amount" className="flex flex-col gap-2 rounded border p-3">
      <div className="flex flex-wrap gap-2">
        {QUICK_AMOUNTS.map((a) => <button key={a} type="button" className={btn} onClick={() => onAdd(a)} disabled={a < min}>{formatCedis(a)}</button>)}
      </div>
      <div className="flex gap-2">
        <input autoFocus inputMode="decimal" placeholder="Amount (GHS)" aria-label="Amount in cedis" value={text} onChange={(e) => setText(e.target.value)} className="w-32 rounded border px-2 py-2" />
        <button type="button" className={primary} disabled={amount === null || below} onClick={() => amount !== null && onAdd(amount)}>Add</button>
        <button type="button" className={btn} onClick={onCancel}>Cancel</button>
      </div>
      {below && <p role="alert" className="text-sm text-red-700">Minimum {formatCedis(min)}</p>}
    </div>
  );
}

/** Spec 6.52: one step per slot; sold-out choices are hidden and upgrades show their extra price. */
function ComboPicker({ slots, hidden, onAdd, onCancel }: {
  slots: ReturnType<typeof comboSlotsOf>; hidden: (variantId: string) => boolean; onAdd: (choices: ComboChoice[]) => void; onCancel: () => void;
}) {
  const [step, setStep] = useState(0);
  const [chosen, setChosen] = useState<ComboChoice[]>([]);
  const slot = slots[step];
  if (!slot) return null;
  const mine = chosen.filter((c) => c.slotId === slot.id);
  const toggle = (variantId: string) => setChosen((cs) => {
    if (cs.some((c) => c.slotId === slot.id && c.variantId === variantId)) return cs.filter((c) => !(c.slotId === slot.id && c.variantId === variantId));
    const others = slot.maxChoices === 1 ? cs.filter((c) => c.slotId !== slot.id) : cs;
    return others.filter((c) => c.slotId === slot.id).length >= slot.maxChoices ? cs : [...others, { slotId: slot.id, variantId }];
  });
  const last = step === slots.length - 1;
  return (
    <div role="dialog" aria-label={slot.name} className="flex flex-col gap-2 rounded border p-3">
      <p className="font-semibold">{slot.name} <span className="text-sm font-normal text-gray-600">(pick {slot.minChoices === slot.maxChoices ? slot.maxChoices : `${slot.minChoices}–${slot.maxChoices}`})</span></p>
      <div className="grid grid-cols-2 gap-2">
        {slot.choices.filter((c) => !hidden(c.variantId)).map((c) => (
          <button key={c.variantId} type="button" aria-pressed={mine.some((m) => m.variantId === c.variantId)} onClick={() => toggle(c.variantId)}
            className={`${btn} text-left ${mine.some((m) => m.variantId === c.variantId) ? 'bg-blue-800 text-white' : ''}`}>
            {slot.choiceNames[c.variantId]}{c.upgradePesewas > 0 ? ` +${formatCedis(c.upgradePesewas)}` : ''}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <button type="button" className={primary} disabled={mine.length < slot.minChoices} onClick={() => (last ? onAdd(chosen) : setStep(step + 1))}>{last ? 'Add meal' : 'Next'}</button>
        <button type="button" className={btn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ReceiptView({ receipt, shop, register, onNew }: { receipt: Receipt; shop: string; register: string; onNew: () => void }) {
  return (
    <section className="flex max-w-sm flex-col gap-2 text-sm">
      <h2 className="text-lg font-semibold">{shop}</h2>
      {receipt.orderNumber && <p className="text-center"><span className="block text-xs">Order number</span><span className="text-5xl font-extrabold">{receipt.orderNumber}</span></p>}
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
        <p key={i} className="flex justify-between"><span>{METHODS.find((m) => m.value === t.method)?.label ?? 'Paid through delivery app'}{t.reference ? ` (${t.reference})` : ''}</span><span>{formatCedis(t.amountPesewas)}</span></p>
      ))}
      <p className="flex justify-between"><span>Change</span><span>{formatCedis(receipt.changeDuePesewas)}</span></p>
      {receipt.serviceMode === 'counter' && receipt.orderNumber && (
        // kitchen slip: printed after the receipt, on its own page (spec 6.51)
        <div className="mt-4 border-t-2 border-dashed pt-3 break-before-page">
          <p className="text-base font-semibold">Kitchen</p>
          <p className="text-4xl font-extrabold">{receipt.orderNumber}</p>
          <p>{DINING.find((o) => o.value === receipt.diningOption)?.label} · {receipt.at.toLocaleTimeString()}</p>
          <ul className="mt-1">{receipt.lines.map((l) => <li key={l.lineId}>{Number(l.quantity)} × {l.label}</li>)}</ul>
        </div>
      )}
      <div className="flex gap-2 print:hidden">
        <button type="button" className={btn} onClick={() => window.print()}>Print</button>
        <button type="button" className={primary} onClick={onNew}>New sale</button>
      </div>
    </section>
  );
}

/** The kitchen slip of an unpaid phone order: its number is what the customer gives when collecting (spec 6.57). */
function PhoneSlip({ slip, customer, onNew }: { slip: { orderNumber: string; lines: Array<{ lineId: string; label: string; quantity: string }> }; customer: string; onNew: () => void }) {
  return (
    <section className="flex max-w-sm flex-col gap-2 text-sm">
      <p className="text-base font-semibold">Kitchen · not paid</p>
      <p className="text-5xl font-extrabold">{slip.orderNumber}</p>
      <p>{customer} pays when collecting.</p>
      <ul>{slip.lines.map((l) => <li key={l.lineId}>{Number(l.quantity)} × {l.label}</li>)}</ul>
      <div className="flex gap-2 print:hidden">
        <button type="button" className={btn} onClick={() => window.print()}>Print</button>
        <button type="button" className={primary} onClick={onNew}>New order</button>
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
