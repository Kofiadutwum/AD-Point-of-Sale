import { notFound } from 'next/navigation';
import { ActionForm, Field } from '@/components/form';
import { PrintButton } from '@/components/print-button';
import { getDb } from '@/db/client';
import { getItemAddOnGroups, listAddOnGroups } from '@/server/add-ons';
import { getServiceChargeBp } from '@/server/tables';
import { formatCedis } from '@/lib/money';
import { currentTicketBranch, getTicket, listApprovers, listOpenTickets, listTicketItems, quoteTicket } from '@/server/tickets';
import { pageCtx } from '../../page-ctx';
import { PrintSlips } from './print-slips';
import {
  addLineAction, cancelAction, moveAction, payAction, payEqualAction, payPartAction, printBillAction, removeLineAction, sendAction, voidAction,
} from './actions';
import { equalShares } from '@/lib/food';

const KITCHEN = { new: 'Not sent', sent: 'Sent', ready: 'Ready', void: 'Voided' } as const;

/** Method, amount (filled with what is due), and reference for one payment; suffix tells shares apart. */
function PayFields({ amount, suffix = '' }: { amount: number; suffix?: string }) {
  return (
    <>
      <label className="flex flex-col gap-1 text-sm">Method
        <select name={`method${suffix}`} className="rounded border border-gray-400 px-3 py-2">
          <option value="cash">Cash</option><option value="momo_manual">MoMo</option><option value="card_terminal">Card</option><option value="bank_transfer">Bank</option>
        </select>
      </label>
      <Field label="Amount paid (GHS)" name={`amount${suffix}`} inputMode="decimal" defaultValue={(amount / 100).toFixed(2)} />
      <Field label="Reference (MoMo, card, bank)" name={`reference${suffix}`} required={false} maxLength={100} />
    </>
  );
}
const STATION = { kitchen: 'Kitchen', bar: 'Bar', grill: 'Grill' } as const;

/** Spec 6.37: a table or named ticket: add items, send them to the kitchen, void, move, print the bill, and take payment. */
export default async function TicketPage({ params, searchParams }: { params: Promise<{ slug: string; ticketId: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug, ticketId } = await params;
  const ctx = await pageCtx(slug, 'take_orders');
  const ticket = await getTicket(getDb(), ctx, ticketId);
  if (!ticket) notFound();
  const open = ticket.status === 'open';
  const branchId = await currentTicketBranch(getDb(), ctx);
  const [items, others, approvers, bp] = await Promise.all([
    open ? listTicketItems(getDb(), ctx) : [], open && branchId ? listOpenTickets(getDb(), ctx, branchId) : [],
    open && branchId ? listApprovers(getDb(), ctx, branchId) : [], getServiceChargeBp(getDb(), ctx),
  ]);
  const quote = open ? await quoteTicket(getDb(), ctx, ticket.id, new Date()) : null;
  const search = await searchParams;
  const wanted = search.item;
  const picked = items.find((i) => i.variantId === wanted);
  const groupIds = picked ? await getItemAddOnGroups(getDb(), ctx, picked.variantId) : [];
  const groups = groupIds.length ? (await listAddOnGroups(getDb(), ctx)).filter((g) => groupIds.includes(g.id)).sort((a, b) => groupIds.indexOf(a.id) - groupIds.indexOf(b.id)) : [];
  const live = ticket.lines.filter((l) => l.kitchenStatus !== 'void');
  // spec 6.38: a split part comes from the address bar (q-<lineId>=quantity), or seat=n picks that seat's unpaid lines
  const unpaid = (l: (typeof live)[number]) => Number(l.quantity) - Number(l.paidQuantity);
  const seatPick = Number(search.seat) || null;
  const part = live.flatMap((l) => {
    const q = seatPick ? (l.seat === seatPick ? unpaid(l) : 0) : Number(search[`q-${l.id}`] ?? 0);
    return q > 0 ? [{ lineId: l.id, quantity: String(q) }] : [];
  });
  const partQuote = open && part.length ? await quoteTicket(getDb(), ctx, ticket.id, new Date(), part) : null;
  const shares = Math.min(20, Math.max(0, Number(search.shares) || 0));
  const seats = [...new Set(live.filter((l) => l.seat && unpaid(l) > 0).map((l) => l.seat!))].sort((a, b) => a - b);
  const canPay = ctx.permissions.includes('make_sale');
  // spec 4.24: the latest kitchen send, for the print helper
  const lastSent = live.reduce<Date | null>((m, l) => (l.sentAt && (!m || l.sentAt > m) ? l.sentAt : m), null);
  const batch = lastSent ? live.filter((l) => l.sentAt?.getTime() === lastSent.getTime()) : [];
  return (
    <main className="flex max-w-2xl flex-col gap-6">
      <a href={`/${slug}/app/tables`} className="text-sm text-blue-800 underline print:hidden">← Tables</a>
      <header>
        <h1 className="text-2xl font-semibold">{ticket.label}</h1>
        <p className="text-sm text-gray-700">{ticket.waiterName} · {ticket.diningOption.replace('_', ' ')} · {open ? 'open' : ticket.status}</p>
      </header>
      <table className="w-full text-sm">
        <tbody>
          {ticket.lines.map((l) => (
            <tr key={l.id} className={`border-b align-top ${l.kitchenStatus === 'void' ? 'text-gray-500 line-through' : ''}`}>
              <td className="py-2">
                {Number(l.quantity)} × {l.name}{l.seat ? ` · seat ${l.seat}` : ''}
                {Number(l.paidQuantity) > 0 && <span className="block pl-3 text-xs text-green-800">paid {Number(l.paidQuantity)} of {Number(l.quantity)}</span>}
                {l.addOns.length > 0 && <span className="block pl-3 text-xs">+ {l.addOns.join(', ')}</span>}
                {l.note && <span className="block pl-3 text-xs italic">{l.note}</span>}
              </td>
              <td className="print:hidden">{STATION[l.station]} · {KITCHEN[l.kitchenStatus]}</td>
              <td className="print:hidden">
                {open && l.kitchenStatus === 'new' && <ActionForm action={removeLineAction.bind(null, slug, ticket.id, l.id)} submitLabel="Remove">{null}</ActionForm>}
                {open && (l.kitchenStatus === 'sent' || l.kitchenStatus === 'ready') && (
                  <details>
                    <summary className="cursor-pointer text-red-700">Void</summary>
                    <ActionForm action={voidAction.bind(null, slug, ticket.id, l.id)} submitLabel="Void with manager PIN">
                      <Field label="Reason" name="reason" maxLength={200} />
                      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="prepared" /> Already prepared (record as waste)</label>
                      <label className="flex flex-col gap-1 text-sm">Manager
                        <select name="approverId" required className="rounded border border-gray-400 px-3 py-2">
                          {approvers.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                      </label>
                      <Field label="Manager PIN" name="pin" type="password" inputMode="numeric" autoComplete="off" />
                    </ActionForm>
                  </details>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {quote && (
        <section aria-label="Bill" className="flex flex-col gap-1 text-sm">
          <h2 className="text-lg font-semibold">Bill</h2>
          {quote.lines.map((l, i) => <p key={i} className="flex justify-between"><span>{Number(l.quantity)} × {l.name}</span><span>{formatCedis(l.totalPesewas)}</span></p>)}
          {quote.taxPesewas > 0 && <p className="flex justify-between"><span>Tax</span><span>{formatCedis(quote.taxPesewas)}</span></p>}
          {quote.serviceChargePesewas > 0 && <p className="flex justify-between"><span>Service charge ({bp / 100}%)</span><span>{formatCedis(quote.serviceChargePesewas)}</span></p>}
          <p className="flex justify-between text-base font-bold"><span>Total</span><span>{formatCedis(quote.totalPesewas)}</span></p>
        </section>
      )}
      {open && (
        <div className="flex flex-col gap-6 print:hidden">
          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">Add an item</h2>
            <form className="flex gap-2">
              <select name="item" defaultValue={picked?.variantId ?? ''} className="flex-1 rounded border border-gray-400 px-3 py-2" aria-label="Item">
                <option value="">Pick an item</option>
                {items.map((i) => <option key={i.variantId} value={i.variantId}>{i.label}</option>)}
              </select>
              <button className="rounded border px-3 py-2">Choose</button>
            </form>
            {picked && (
              <ActionForm action={addLineAction.bind(null, slug, ticket.id, picked.variantId, picked.unitId)} submitLabel={`Add ${picked.label}`}>
                <Field label="Quantity" name="quantity" inputMode="decimal" defaultValue="1" />
                {groups.map((g) => (
                  <fieldset key={g.id} className="flex flex-col gap-1 text-sm">
                    <legend>{g.name} {g.minChoices > 0 ? `(pick ${g.minChoices}${g.maxChoices > g.minChoices ? `–${g.maxChoices}` : ''})` : `(up to ${g.maxChoices}, optional)`}</legend>
                    {g.options.filter((o) => o.active).map((o) => (
                      <label key={o.id} className="flex items-center gap-2">
                        <input type={g.maxChoices === 1 ? 'radio' : 'checkbox'} name={`group-${g.id}`} value={o.id} required={g.maxChoices === 1 && g.minChoices > 0} />
                        {o.name}{o.pricePesewas > 0 ? ` (+GHS ${(o.pricePesewas / 100).toFixed(2)})` : ''}
                      </label>
                    ))}
                  </fieldset>
                ))}
                <Field label="Note for the kitchen" name="note" maxLength={140} required={false} />
                <Field label="Seat (optional, for splitting by seat)" name="seat" type="number" min={1} max={50} required={false} />
              </ActionForm>
            )}
          </section>
          <div className="flex flex-wrap gap-2">
            <ActionForm action={sendAction.bind(null, slug, ticket.id)} submitLabel="Send to kitchen">{null}</ActionForm>
            <PrintSlips slug={slug} batchKey={lastSent ? `${ticket.id}-${lastSent.getTime()}` : null} order={{
              kind: 'new', orderNumber: null, label: ticket.label, dining: ticket.diningOption, at: (lastSent ?? new Date()).toISOString(), timezone: ctx.timezone, by: ticket.waiterName,
              lines: batch.map((l) => ({ name: l.name, quantity: l.quantity, station: l.station, addOns: l.addOns, note: l.note })),
            }} />
            <ActionForm action={printBillAction.bind(null, slug, ticket.id)} submitLabel="Mark bill printed">{null}</ActionForm>
            <PrintButton />
          </div>
          {others.filter((o) => o.id !== ticket.id).length > 0 && live.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold">Move items</h2>
              <ActionForm action={moveAction.bind(null, slug, ticket.id)} submitLabel="Move">
                {live.map((l) => <label key={l.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="lineId" value={l.id} /> {Number(l.quantity)} × {l.name}</label>)}
                <label className="flex flex-col gap-1 text-sm">To
                  <select name="to" className="rounded border border-gray-400 px-3 py-2">
                    {others.filter((o) => o.id !== ticket.id).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </label>
              </ActionForm>
            </section>
          )}
          {canPay && live.some((l) => unpaid(l) > 0) && (
            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold">Split the bill</h2>
              <form className="flex flex-col gap-1 text-sm">
                <p>By item: how much of each does this person pay?</p>
                {live.filter((l) => unpaid(l) > 0).map((l) => (
                  <label key={l.id} className="flex items-center gap-2">
                    <input name={`q-${l.id}`} type="number" step="any" min="0" max={unpaid(l)} defaultValue={part.find((p) => p.lineId === l.id)?.quantity ?? ''}
                      aria-label={`Quantity of ${l.name}`} className="w-20 rounded border px-2 py-1" />
                    of {unpaid(l)} × {l.name}{l.seat ? ` (seat ${l.seat})` : ''}
                  </label>
                ))}
                <button className="self-start rounded border px-3 py-2">Work out this part</button>
              </form>
              {seats.length > 0 && (
                <p className="flex flex-wrap gap-2 text-sm">By seat: {seats.map((n) => <a key={n} href={`?seat=${n}`} className="rounded border px-3 py-1">Seat {n}</a>)}</p>
              )}
              {partQuote && (
                <div className="rounded border p-3">
                  <p className="font-semibold">This part: {formatCedis(partQuote.totalPesewas)}{partQuote.serviceChargePesewas > 0 ? ` (incl. service ${formatCedis(partQuote.serviceChargePesewas)})` : ''}</p>
                  <ActionForm action={payPartAction.bind(null, slug, ticket.id, JSON.stringify(part))} submitLabel="Pay this part">
                    <PayFields amount={partQuote.totalPesewas} />
                  </ActionForm>
                </div>
              )}
              <form className="flex items-end gap-2 text-sm">
                <Field label="Split equally between" name="shares" type="number" min={2} max={20} defaultValue={shares ? String(shares) : ''} />
                <button className="rounded border px-3 py-2">Show shares</button>
              </form>
              {shares >= 2 && quote && (
                <ActionForm action={payEqualAction.bind(null, slug, ticket.id, shares)} submitLabel="Take all shares">
                  {equalShares(quote.totalPesewas, shares).map((amount, i) => (
                    <fieldset key={i} className="rounded border p-2 text-sm"><legend>Share {i + 1}</legend><PayFields amount={amount} suffix={`-${i}`} /></fieldset>
                  ))}
                </ActionForm>
              )}
            </section>
          )}
          {canPay && <section>
            <h2 className="text-lg font-semibold">Pay the bill</h2>
            <ActionForm action={payAction.bind(null, slug, ticket.id)} submitLabel="Take payment">
              <label className="flex flex-col gap-1 text-sm">Method
                <select name="method" className="rounded border border-gray-400 px-3 py-2">
                  <option value="cash">Cash</option><option value="momo_manual">MoMo</option><option value="card_terminal">Card</option><option value="bank_transfer">Bank</option>
                </select>
              </label>
              <Field label="Amount paid (GHS)" name="amount" inputMode="decimal" />
              <Field label="Reference (MoMo, card, bank)" name="reference" required={false} maxLength={100} />
            </ActionForm>
          </section>}
          {live.every((l) => l.kitchenStatus === 'new') && (
            <details>
              <summary className="cursor-pointer text-sm text-red-700">Cancel this ticket</summary>
              <ActionForm action={cancelAction.bind(null, slug, ticket.id)} submitLabel="Cancel ticket"><Field label="Reason" name="reason" maxLength={200} /></ActionForm>
            </details>
          )}
        </div>
      )}
    </main>
  );
}
