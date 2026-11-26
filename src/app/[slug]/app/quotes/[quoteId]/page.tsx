import { notFound } from 'next/navigation';
import { ActionForm, Field } from '@/components/form';
import { PrintButton } from '@/components/print-button';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { listApprovers } from '@/server/approvals';
import { getQuote } from '@/server/quotes';
import { pageCtx } from '../../page-ctx';
import { cancelQuoteAction, invoiceQuoteAction, sellQuoteAction } from './actions';

const select = 'rounded border border-gray-400 px-3 py-2';

function Approval({ approvers }: { approvers: Array<{ id: string; name: string }> }) {
  return (
    <fieldset className="flex flex-col gap-2 rounded border border-gray-300 p-3">
      <legend className="px-1 text-sm">Manager approval (only for an expired quote)</legend>
      <select name="approverId" className={select} defaultValue=""><option value="">No approval</option>{approvers.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
      <Field label="Manager PIN" name="pin" type="password" inputMode="numeric" autoComplete="off" required={false} />
    </fieldset>
  );
}

export default async function QuotePage({ params }: { params: Promise<{ slug: string; quoteId: string }> }) {
  const { slug, quoteId } = await params;
  const ctx = await pageCtx(slug, 'make_sale');
  const [q, approvers] = await Promise.all([getQuote(getDb(), ctx, quoteId), listApprovers(getDb(), ctx)]);
  if (!q) notFound();
  const link = `${process.env.APP_URL ?? 'http://localhost:3000'}/${slug}/d/${q.shareCode}`;
  return (
    <main className="flex max-w-2xl flex-col gap-6">
      <a href={`/${slug}/app/quotes`} className="text-sm text-blue-800 underline">← Quotes</a>
      <section className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Quote {q.number}</h1>
        <p className="text-sm text-gray-700">{q.customerName ?? 'No customer'} · valid until {q.validUntil} · {q.status}</p>
        <table className="text-sm">
          <thead><tr className="text-left"><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
          <tbody>{q.lines.map((l, i) => <tr key={i}><td>{l.name}</td><td>{Number(l.quantity)} {l.unitName}</td><td>{formatCedis(l.unitPricePesewas)}</td><td>{formatCedis(l.totalPesewas)}</td></tr>)}</tbody>
        </table>
        <p className="text-lg font-semibold">Total {formatCedis(q.totalPesewas)}</p>
        {q.note && <p className="text-sm">{q.note}</p>}
        <p className="break-all text-sm">Share: <a className="text-blue-800 underline" href={`/${slug}/d/${q.shareCode}`}>{link}</a></p>
        <a className="text-sm text-green-800 underline" href={`https://wa.me/?text=${encodeURIComponent(`Quote ${q.number}: ${link}`)}`}>Send by WhatsApp</a>
        <PrintButton />
      </section>
      {q.status === 'open' && (
        <>
          <section className="flex max-w-md flex-col gap-2">
            <h2 className="text-lg font-semibold">Sell now (at a till)</h2>
            <ActionForm action={sellQuoteAction.bind(null, slug, q.id)} submitLabel="Take payment">
              <Field label="Cash (GHS)" name="cash" inputMode="decimal" required={false} />
              <div className="flex flex-wrap items-end gap-2">
                <select name="otherMethod" className={select} defaultValue="momo_manual" aria-label="Other payment"><option value="momo_manual">MoMo</option><option value="card_terminal">Card</option><option value="bank_transfer">Bank transfer</option></select>
                <Field label="Amount (GHS)" name="otherAmount" inputMode="decimal" required={false} />
                <Field label="Reference" name="otherReference" required={false} maxLength={100} />
              </div>
              <Approval approvers={approvers} />
            </ActionForm>
          </section>
          {ctx.permissions.includes('issue_invoices') && q.customerId && (
            <section className="flex max-w-md flex-col gap-2">
              <h2 className="text-lg font-semibold">Invoice it (pay later)</h2>
              <ActionForm action={invoiceQuoteAction.bind(null, slug, q.id, q.customerId)} submitLabel="Issue invoice">
                <Field label="Due date" name="dueDate" type="date" />
                <Approval approvers={approvers} />
              </ActionForm>
            </section>
          )}
          <ActionForm action={cancelQuoteAction.bind(null, slug, q.id)} submitLabel="Cancel quote">{null}</ActionForm>
        </>
      )}
    </main>
  );
}
