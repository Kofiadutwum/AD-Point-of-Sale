import { ActionForm, Check, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { listBranches } from '@/server/branches';
import { listBills, listPurchaseOrders, listSuppliers, type SupplierRow } from '@/server/purchasing';
import { pageCtx } from '../page-ctx';
import { BranchSelect, select, StockRows } from '../stock/parts';
import { createPoAction, linkItemAction, payBillAction, saveSupplierAction, suggestAction, supplierReturnAction } from './actions';

const STATUS: Record<string, string> = { draft: 'Draft', sent: 'Sent', partly_received: 'Part received', received: 'Received', closed: 'Closed' };

function SupplierSelect({ suppliers }: { suppliers: SupplierRow[] }) {
  return <label className="flex flex-col gap-1 text-sm">Supplier<select name="supplierId" className={select} required>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>;
}

/** Spec 4.19: suppliers, purchase orders (including suggested drafts), supplier bills, and returns to suppliers. */
export default async function PurchasingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'manage_purchasing');
  const db = getDb();
  const [sups, orders, bills, branches] = await Promise.all([listSuppliers(db, ctx), listPurchaseOrders(db, ctx), listBills(db, ctx, new Date()), listBranches(db, ctx)]);
  const open = bills.filter((b) => b.status !== 'paid');
  return (
    <main className="flex max-w-3xl flex-col gap-8">
      <a href={`/${slug}/app/stock`} className="text-sm text-blue-800 underline">← Stock</a>
      <h1 className="text-2xl font-semibold">Suppliers and purchase orders</h1>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Purchase orders</h2>
        <ul className="text-sm">{orders.map((o) => (
          <li key={o.id}><a className="text-blue-800 underline" href={`/${slug}/app/purchasing/${o.id}`}>{o.number}</a> · {o.supplierName} · {STATUS[o.status]}{o.suggested && o.status === 'draft' ? ' (suggested, review it)' : ''}</li>
        ))}</ul>
        <ActionForm action={suggestAction.bind(null, slug)} submitLabel="Suggest orders from reorder levels and sales">
          <BranchSelect name="branchId" label="For branch" branches={branches} />
        </ActionForm>
        {sups.length > 0 && (
          <details><summary className="cursor-pointer text-sm text-blue-800 underline">New purchase order</summary>
            <ActionForm action={createPoAction.bind(null, slug)} submitLabel="Create draft">
              <SupplierSelect suppliers={sups} />
              <BranchSelect name="branchId" label="Deliver to" branches={branches} />
              <StockRows cost />
              <Field label="Note" name="note" required={false} maxLength={300} />
            </ActionForm>
          </details>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Supplier bills ({open.length} open)</h2>
        {open.length === 0 ? <p className="text-sm text-gray-700">Nothing owed.</p> : open.map((b) => (
          <div key={b.id} className={`flex flex-col gap-1 rounded border p-2 text-sm ${b.status === 'overdue' ? 'border-red-600' : 'border-gray-300'}`}>
            <p>{b.supplierName}{b.reference ? ` · ${b.reference}` : ''} · owed {formatCedis(b.owedPesewas)} of {formatCedis(b.amountPesewas)} · due {b.dueDate}{b.status === 'overdue' ? ' (overdue)' : ''}</p>
            <ActionForm action={payBillAction.bind(null, slug, b.id)} submitLabel="Record payment">
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Amount (GHS)" name="amount" inputMode="decimal" />
                <select name="method" className={select} aria-label="Paid by"><option value="cash">Cash</option><option value="momo_manual">MoMo</option><option value="bank_transfer">Bank</option><option value="cheque">Cheque</option><option value="credit">Supplier credit</option></select>
                <Field label="Reference" name="reference" required={false} maxLength={100} />
              </div>
            </ActionForm>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Suppliers</h2>
        <table className="text-sm"><thead><tr className="text-left"><th>Name</th><th>Phone</th><th>Terms</th><th>Lead time</th><th>Owed</th><th>Credit</th></tr></thead>
          <tbody>{sups.map((s) => <tr key={s.id}><td>{s.name}</td><td>{s.phone ?? ''}</td><td>{s.paymentTermsDays} days</td><td>{s.leadTimeDays} days</td><td>{formatCedis(s.owedPesewas)}</td><td>{formatCedis(s.creditPesewas)}</td></tr>)}</tbody>
        </table>
        <details><summary className="cursor-pointer text-sm text-blue-800 underline">Add a supplier</summary>
          <ActionForm action={saveSupplierAction.bind(null, slug)} submitLabel="Save supplier">
            <Field label="Name" name="name" maxLength={80} />
            <Field label="Phone" name="phone" type="tel" required={false} />
            <Field label="Email" name="email" type="email" required={false} />
            <Field label="Pay within (days)" name="terms" type="number" min={0} max={365} defaultValue={0} />
            <Field label="Delivers within (days)" name="lead" type="number" min={0} max={365} defaultValue={7} />
          </ActionForm>
        </details>
        {sups.length > 0 && (
          <details><summary className="cursor-pointer text-sm text-blue-800 underline">Link an item to a supplier (pack size and cost)</summary>
            <ActionForm action={linkItemAction.bind(null, slug)} submitLabel="Link item">
              <SupplierSelect suppliers={sups} />
              <Field label="Barcode of the pack you buy (or SKU for single pieces)" name="code" maxLength={60} />
              <Field label="Last cost per pack (GHS)" name="cost" inputMode="decimal" required={false} />
              <Check name="isMain" label="Main supplier (suggested orders go here)" defaultChecked />
            </ActionForm>
          </details>
        )}
        {sups.length > 0 && (
          <details><summary className="cursor-pointer text-sm text-blue-800 underline">Return goods to a supplier</summary>
            <ActionForm action={supplierReturnAction.bind(null, slug)} submitLabel="Record return">
              <SupplierSelect suppliers={sups} />
              <BranchSelect name="branchId" label="From branch" branches={branches} />
              <StockRows rows={3} />
              <Field label="Reason (damaged, expired, wrong item)" name="reason" maxLength={200} />
              <Field label="Credit expected (GHS, blank = at cost)" name="credit" inputMode="decimal" required={false} />
            </ActionForm>
          </details>
        )}
      </section>
    </main>
  );
}
