import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { getServiceChargeBp, listTables } from '@/server/tables';
import { currentTicketBranch, listOpenTickets } from '@/server/tickets';
import { AutoRefresh } from '../kitchen/auto-refresh';
import { pageCtx } from '../page-ctx';
import { newTicketAction, openTableAction, saveTableAction, serviceChargeAction } from './actions';

const STATUS = {
  free: ['Free', 'bg-green-100'], ordering: ['Ordering', 'bg-blue-100'], waiting_for_food: ['Waiting for food', 'bg-amber-100'], bill_printed: ['Bill printed', 'bg-purple-100'],
} as const;

/** Spec 4.24: the branch's tables with their status, open tickets, and (for managers) table and service charge setup. */
export default async function TablesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'take_orders');
  const branchId = await currentTicketBranch(getDb(), ctx);
  if (!branchId) return <main><p>Open tables from a till (switch in with your PIN), or ask a manager to set your branch.</p></main>;
  const manager = ctx.permissions.includes('manage_shop_settings');
  const [tables, open, bp] = await Promise.all([listTables(getDb(), ctx, branchId), listOpenTickets(getDb(), ctx, branchId), manager ? getServiceChargeBp(getDb(), ctx) : 0]);
  const named = open.filter((tk) => !tk.tableId);
  return (
    <main className="flex max-w-3xl flex-col gap-6">
      <AutoRefresh ms={15_000} />
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Tables</h1>
      {tables.length === 0 && <p className="text-sm text-gray-700">No tables yet.{manager ? ' Add them below.' : ' Ask a manager to add them.'}</p>}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {tables.filter((tb) => tb.active || tb.openTicketId).map((tb) => (
          <li key={tb.id} className={`flex flex-col gap-2 rounded border p-3 ${STATUS[tb.status][1]}`}>
            <span className="text-lg font-semibold">{tb.name}</span>
            <span className="text-sm">{STATUS[tb.status][0]}</span>
            {tb.openTicketId
              ? <a href={`/${slug}/app/tickets/${tb.openTicketId}`} className="text-blue-800 underline">Open ticket</a>
              : <ActionForm action={openTableAction.bind(null, slug, tb.id)} submitLabel="Seat guests">{null}</ActionForm>}
          </li>
        ))}
      </ul>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Named tickets</h2>
        <ul className="flex flex-col gap-1 text-sm">
          {named.map((tk) => <li key={tk.id}><a href={`/${slug}/app/tickets/${tk.id}`} className="text-blue-800 underline">{tk.label}</a> · {tk.lineCount} items · {tk.waiterName}</li>)}
        </ul>
        <ActionForm action={newTicketAction.bind(null, slug)} submitLabel="New ticket">
          <Field label="Name (customer or number)" name="label" maxLength={40} />
          <label className="flex flex-col gap-1 text-sm">Dining
            <select name="diningOption" className="rounded border border-gray-400 px-3 py-2">
              <option value="eat_in">Eat in</option><option value="takeaway">Takeaway</option><option value="delivery">Delivery</option>
            </select>
          </label>
        </ActionForm>
      </section>
      {manager && (
        <section className="flex flex-col gap-3 border-t pt-4">
          <h2 className="text-lg font-semibold">Set up tables</h2>
          {tables.map((tb) => (
            <ActionForm key={tb.id} action={saveTableAction.bind(null, slug, branchId, tb.id)} submitLabel="Save">
              <Field label="Table name" name="name" maxLength={20} defaultValue={tb.name} />
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={tb.active} /> In use</label>
            </ActionForm>
          ))}
          <ActionForm action={saveTableAction.bind(null, slug, branchId, null)} submitLabel="Add table">
            <Field label="New table name (e.g. Table 5, Patio 2)" name="name" maxLength={20} />
            <input type="hidden" name="active" value="on" />
          </ActionForm>
          <ActionForm action={serviceChargeAction.bind(null, slug)} submitLabel="Save service charge">
            <Field label="Service charge on table bills (%; 0 = none)" name="percent" inputMode="decimal" required={false} defaultValue={String(bp / 100)} />
          </ActionForm>
        </section>
      )}
    </main>
  );
}
