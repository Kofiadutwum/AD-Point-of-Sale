import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { listApprovers } from '@/server/approvals';
import { findReturnableSale } from '@/server/returns';
import { getReturnSettings } from '@/server/shop-settings';
import { pageCtx } from '../page-ctx';
import { noReceiptAction, processReturnAction } from './actions';

const select = 'rounded border border-gray-400 px-3 py-2';

function ApproverFields({ approvers }: { approvers: Array<{ id: string; name: string }> }) {
  return (
    <fieldset className="flex flex-col gap-2 rounded border border-gray-300 p-3">
      <legend className="px-1 text-sm">Manager approval (when needed)</legend>
      <select name="approverId" className={select} defaultValue="">
        <option value="">No approval</option>
        {approvers.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <Field label="Manager PIN" name="pin" type="password" inputMode="numeric" autoComplete="off" required={false} />
    </fieldset>
  );
}

function Condition({ name }: { name: string }) {
  return (
    <select name={name} className={select} defaultValue="saleable" aria-label="Condition">
      <option value="saleable">Can be sold again</option>
      <option value="damaged">Damaged</option>
      <option value="expired">Expired</option>
    </select>
  );
}

export default async function ReturnsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ receipt?: string }> }) {
  const { slug } = await params;
  const { receipt } = await searchParams;
  const ctx = await pageCtx(slug, 'process_return');
  const [sale, approvers, settings] = await Promise.all([
    receipt ? findReturnableSale(getDb(), ctx, receipt) : null, listApprovers(getDb(), ctx), getReturnSettings(getDb(), ctx),
  ]);
  const open = sale?.lines.filter((l) => l.returnable !== '0.000') ?? [];
  return (
    <main className="flex max-w-2xl flex-col gap-8">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <section className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">Returns</h1>
        <form method="get" className="flex items-end gap-2">
          <label className="flex flex-col gap-1 text-sm">Receipt number
            <input name="receipt" defaultValue={receipt ?? ''} required maxLength={40} className={select} placeholder="B1-T1-000123" />
          </label>
          <button type="submit" className="rounded bg-blue-800 px-4 py-2 text-white">Find</button>
        </form>
        {receipt && !sale && <p role="alert" className="text-sm text-red-700">No sale with that receipt number at your branch.</p>}
      </section>

      {sale && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Receipt {sale.receiptNumber}</h2>
          <table className="text-sm">
            <thead><tr className="text-left"><th>Item</th><th>Sold</th><th>Back already</th><th>Refund each</th></tr></thead>
            <tbody>
              {sale.lines.map((l) => (
                <tr key={l.saleLineId}><td>{l.name} ({l.unitName})</td><td>{l.sold}</td><td>{l.returned}</td><td>{formatCedis(l.unitRefundPesewas)}</td></tr>
              ))}
            </tbody>
          </table>
          {open.length === 0 ? <p className="text-sm text-gray-700">Nothing on this receipt can come back.</p> : (
            <ActionForm action={processReturnAction.bind(null, slug, sale.saleId, open.map((l) => l.saleLineId))} submitLabel="Record return and refund">
              {open.map((l) => (
                <div key={l.saleLineId} className="flex flex-wrap items-end gap-2">
                  <Field label={`${l.name}: how many back (up to ${l.returnable})`} name={`qty_${l.saleLineId}`} inputMode="decimal" required={false} defaultValue="" />
                  <Condition name={`cond_${l.saleLineId}`} />
                </div>
              ))}
              <label className="flex flex-col gap-1 text-sm">Refund by
                <select name="refundMethod" className={select} defaultValue={sale.method === 'channel_settlement' ? 'cash' : sale.method}>
                  <option value="cash">Cash</option>
                  <option value="momo_manual">MoMo</option>
                  <option value="card_terminal">Card</option>
                  <option value="bank_transfer">Bank transfer</option>
                  {sale.customerId && <option value="store_credit">Store credit</option>}
                </select>
              </label>
              <Field label="Reference (MoMo, card, or bank)" name="reference" required={false} maxLength={100} />
              <Field label="Reason" name="reason" maxLength={200} />
              <ApproverFields approvers={approvers} />
            </ActionForm>
          )}
        </section>
      )}

      {settings.allowNoReceiptReturns && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">No receipt</h2>
          <p className="text-sm text-gray-700">Store credit only, at the lowest price the item sold for in the last 90 days. A manager must approve.</p>
          <ActionForm action={noReceiptAction.bind(null, slug)} submitLabel="Take back for store credit">
            <Field label="Customer name" name="name" maxLength={80} />
            <Field label="Customer phone" name="phone" type="tel" />
            <Field label="Item barcode or SKU" name="code" maxLength={60} />
            <Field label="Quantity" name="quantity" inputMode="decimal" defaultValue="1" />
            <Condition name="condition" />
            <Field label="Reason" name="reason" maxLength={200} />
            <ApproverFields approvers={approvers} />
          </ActionForm>
        </section>
      )}
    </main>
  );
}
