import { notFound } from 'next/navigation';
import { ActionForm, Check, Field } from '@/components/form';
import { PrintButton } from '@/components/print-button';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { getPurchaseOrder, purchaseOrderMessage } from '@/server/purchasing';
import { pageCtx } from '../../page-ctx';
import { closePoAction, markSentAction, receivePoAction } from '../actions';

/** Spec 4.19: review, send by WhatsApp or email, receive all or part (cost, batch and expiry, serials), and close. */
export default async function PurchaseOrderPage({ params }: { params: Promise<{ slug: string; poId: string }> }) {
  const { slug, poId } = await params;
  const ctx = await pageCtx(slug, 'manage_purchasing');
  const po = await getPurchaseOrder(getDb(), ctx, poId);
  if (!po) notFound();
  const message = purchaseOrderMessage(po);
  const receiving = po.status === 'sent' || po.status === 'partly_received';
  return (
    <main className="flex max-w-3xl flex-col gap-5">
      <a href={`/${slug}/app/purchasing`} className="text-sm text-blue-800 underline">← Purchasing</a>
      <h1 className="text-2xl font-semibold">Purchase order {po.number}</h1>
      <p className="text-sm text-gray-700">{po.supplierName} · deliver to {po.branchName} · {po.status.replace('_', ' ')}{po.suggested ? ' · suggested' : ''}</p>
      <table className="text-sm"><thead><tr className="text-left"><th>Item</th><th>Ordered</th><th>Received</th><th>Cost each</th></tr></thead>
        <tbody>{po.lines.map((l) => <tr key={l.id}><td>{l.name}</td><td>{Number(l.quantity)} {l.unitName}</td><td>{Number(l.receivedQuantity)}</td><td>{formatCedis(l.unitCostPesewas)}</td></tr>)}</tbody>
      </table>
      <div className="flex flex-wrap gap-3 text-sm">
        {po.supplierPhone && <a className="text-green-800 underline" href={`https://wa.me/${po.supplierPhone}?text=${encodeURIComponent(message)}`}>Send by WhatsApp</a>}
        {po.supplierEmail && <a className="text-blue-800 underline" href={`mailto:${po.supplierEmail}?subject=${encodeURIComponent(`Purchase order ${po.number}`)}&body=${encodeURIComponent(message)}`}>Send by email</a>}
        <PrintButton />
      </div>
      {po.status === 'draft' && <ActionForm action={markSentAction.bind(null, slug, po.id)} submitLabel="I have sent it to the supplier"><span /></ActionForm>}
      {receiving && (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Receive delivery</h2>
          <ActionForm action={receivePoAction.bind(null, slug, po.id)} submitLabel="Receive">
            {po.lines.map((l) => {
              const left = Number(l.quantity) - Number(l.receivedQuantity);
              return left <= 0 ? null : (
                <fieldset key={l.id} className="flex flex-wrap items-end gap-2 border-b pb-2">
                  <legend className="text-sm font-medium">{l.name} ({left} {l.unitName} to come)</legend>
                  <Field label="Quantity" name={`rq_${l.id}`} inputMode="decimal" defaultValue={String(left)} required={false} />
                  <Field label="Total cost (GHS)" name={`rc_${l.id}`} inputMode="decimal" defaultValue={((left * l.unitCostPesewas) / 100).toFixed(2)} required={false} />
                  {l.tracking === 'batch' && <><Field label="Batch" name={`rb_${l.id}`} required={false} /><Field label="Expiry" name={`re_${l.id}`} type="date" required={false} /></>}
                  {l.tracking === 'serial' && <Field label="Serial numbers (space separated)" name={`rs_${l.id}`} required={false} />}
                </fieldset>
              );
            })}
            <Check name="paidNow" label="Paid on delivery (otherwise a supplier bill is recorded)" />
            <Field label="Supplier invoice number" name="billReference" required={false} maxLength={60} />
          </ActionForm>
        </section>
      )}
      {po.status !== 'closed' && po.status !== 'received' && <ActionForm action={closePoAction.bind(null, slug, po.id)} submitLabel="Close order (nothing more to come)"><span /></ActionForm>}
    </main>
  );
}
