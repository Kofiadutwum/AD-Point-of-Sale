import { notFound } from 'next/navigation';
import { ActionForm, Field } from '@/components/form';
import { PrintButton } from '@/components/print-button';
import { getDb } from '@/db/client';
import { getItemAddOnGroups, listAddOnGroups } from '@/server/add-ons';
import { getServiceChargeBp } from '@/server/tables';
import { currentTicketBranch, getTicket, listApprovers, listOpenTickets, listTicketItems } from '@/server/tickets';
import { pageCtx } from '../../page-ctx';
import {
  addLineAction, cancelAction, moveAction, payAction, printBillAction, removeLineAction, sendAction, voidAction,
} from './actions';

const KITCHEN = { new: 'Not sent', sent: 'In the kitchen', ready: 'Ready', void: 'Voided' } as const;
const STATION = { kitchen: 'Kitchen', bar: 'Bar', grill: 'Grill' } as const;

/** Spec 6.37: a table or named ticket: add items, send them to the kitchen, void, move, print the bill, and take payment. */
export default async function TicketPage({ params, searchParams }: { params: Promise<{ slug: string; ticketId: string }>; searchParams: Promise<{ item?: string }> }) {
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
  const wanted = (await searchParams).item;
  const picked = items.find((i) => i.variantId === wanted);
  const groupIds = picked ? await getItemAddOnGroups(getDb(), ctx, picked.variantId) : [];
  const groups = groupIds.length ? (await listAddOnGroups(getDb(), ctx)).filter((g) => groupIds.includes(g.id)).sort((a, b) => groupIds.indexOf(a.id) - groupIds.indexOf(b.id)) : [];
  const live = ticket.lines.filter((l) => l.kitchenStatus !== 'void');
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
                {Number(l.quantity)} × {l.name}
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
      {bp > 0 && <p className="text-sm">A {bp / 100}% service charge is added when the bill is paid.</p>}
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
              </ActionForm>
            )}
          </section>
          <div className="flex flex-wrap gap-2">
            <ActionForm action={sendAction.bind(null, slug, ticket.id)} submitLabel="Send to kitchen">{null}</ActionForm>
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
          <section>
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
          </section>
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
