import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { listApprovers } from '@/server/approvals';
import { listBranches } from '@/server/branches';
import { ADJUSTMENT_REASONS, inventoryValuation, listCounts, listTransfers, lowStock } from '@/server/inventory';
import { pageCtx } from '../page-ctx';
import { adjustAction, sendTransferAction, startCountAction } from './actions';
import { ApproverFields, BranchSelect, select, StockRows } from './parts';

/** Spec 4.19: stock in one place: low stock, value, transfers between branches, counts, and adjustments. */
export default async function StockPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'receive_stock');
  const can = (p: string) => ctx.permissions.includes(p as never);
  const db = getDb();
  const [branches, low, transfers, counts, value, approvers] = await Promise.all([
    listBranches(db, ctx), lowStock(db, ctx), listTransfers(db, ctx), can('stock_count') ? listCounts(db, ctx) : [], can('view_reports') ? inventoryValuation(db, ctx) : null, listApprovers(db, ctx),
  ]);
  return (
    <main className="flex max-w-3xl flex-col gap-8">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Stock</h1>
      <nav className="flex flex-wrap gap-3 text-sm">
        <a className="text-blue-800 underline" href={`/${slug}/app/stock/receive`}>Receive stock</a>
        {can('manage_purchasing') && <a className="text-blue-800 underline" href={`/${slug}/app/purchasing`}>Suppliers and purchase orders</a>}
        {can('manage_products') && <a className="text-blue-800 underline" href={`/${slug}/app/stock/labels`}>Print barcode labels</a>}
      </nav>

      <section>
        <h2 className="text-lg font-semibold">Low stock ({low.length})</h2>
        {low.length === 0 ? <p className="text-sm text-gray-700">Nothing at or below its reorder level.</p> : (
          <table className="text-sm"><thead><tr className="text-left"><th>Item</th><th>Branch</th><th>On hand</th><th>Reorder at</th><th>Supplier</th></tr></thead>
            <tbody>{low.slice(0, 50).map((l, i) => <tr key={i} className={Number(l.onHand) <= 0 ? 'text-red-700' : ''}><td>{l.name}</td><td>{l.branch}</td><td>{Number(l.onHand)}</td><td>{l.reorderLevel ? Number(l.reorderLevel) : '—'}</td><td>{l.supplier ?? '—'}</td></tr>)}</tbody>
          </table>
        )}
      </section>

      {value && (
        <section>
          <h2 className="text-lg font-semibold">Stock value (average cost): {formatCedis(value.totalPesewas)}</h2>
          <ul className="text-sm">
            {value.branches.map((b) => <li key={b.branchId}>{b.name}: {formatCedis(b.valuePesewas)}</li>)}
            {value.inTransitPesewas > 0 && <li>In transit between branches: {formatCedis(value.inTransitPesewas)}</li>}
          </ul>
          <details className="text-sm"><summary>By category</summary><ul>{value.categories.map((c) => <li key={c.name}>{c.name}: {formatCedis(c.valuePesewas)}</li>)}</ul></details>
        </section>
      )}

      {branches.length > 1 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Transfers between branches</h2>
          <ul className="text-sm">{transfers.map((t) => (
            <li key={t.id}><a className="text-blue-800 underline" href={`/${slug}/app/stock/transfers/${t.id}`}>{t.number}</a> · {t.fromName} → {t.toName} · {t.status === 'sent' ? 'in transit' : 'received'}</li>
          ))}</ul>
          {can('transfer_stock') && (
            <ActionForm action={sendTransferAction.bind(null, slug)} submitLabel="Send transfer">
              <div className="flex gap-2"><BranchSelect name="fromBranchId" label="From" branches={branches} /><BranchSelect name="toBranchId" label="To" branches={[...branches].reverse()} /></div>
              <StockRows rows={4} />
              <Field label="Note" name="note" required={false} maxLength={200} />
            </ActionForm>
          )}
        </section>
      )}

      {can('stock_count') && (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Stock counts</h2>
          <ul className="text-sm">{counts.map((c) => (
            <li key={c.id}><a className="text-blue-800 underline" href={`/${slug}/app/stock/counts/${c.id}`}>{c.startedAt.toISOString().slice(0, 10)} · {c.branchName}</a> · {c.status}{c.value !== null ? ` · differences ${formatCedis(c.value)}` : ''}</li>
          ))}</ul>
          <ActionForm action={startCountAction.bind(null, slug)} submitLabel="Start a count">
            <BranchSelect name="branchId" label="Branch" branches={branches} />
            <p className="text-xs text-gray-600">Selling can go on while you count; sales after the start are taken into account.</p>
          </ActionForm>
        </section>
      )}

      {can('adjust_stock') && (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Adjust stock</h2>
          <ActionForm action={adjustAction.bind(null, slug)} submitLabel="Adjust">
            <BranchSelect name="branchId" label="Branch" branches={branches} />
            <StockRows rows={1} />
            <label className="flex flex-col gap-1 text-sm">Reason
              <select name="reason" className={select}>{Object.entries(ADJUSTMENT_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            </label>
            <Field label="Note" name="note" required={false} maxLength={200} />
            <ApproverFields approvers={approvers} />
          </ActionForm>
        </section>
      )}
    </main>
  );
}
