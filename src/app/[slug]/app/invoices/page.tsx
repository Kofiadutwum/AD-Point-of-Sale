import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { listInvoices } from '@/server/quotes';
import { pageCtx } from '../page-ctx';
import { ItemRows } from '../quotes/item-rows';
import { createInvoiceAction } from './actions';

const STATUS = { paid: 'Paid', due: 'Due', overdue: 'Overdue' } as const;

export default async function InvoicesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'issue_invoices');
  const list = await listInvoices(getDb(), ctx, new Date());
  return (
    <main className="flex max-w-2xl flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Invoices</h1>
      <p className="text-sm text-gray-700">An invoice goes on the customer&apos;s account; payments are taken there. Issue invoices at a till.</p>
      <ActionForm action={createInvoiceAction.bind(null, slug)} submitLabel="Issue invoice">
        <ItemRows discounts={ctx.permissions.includes('give_discount')} />
        <Field label="Due date" name="dueDate" type="date" />
      </ActionForm>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Invoices</h2>
        {list.length === 0 ? <p className="text-sm text-gray-700">No invoices yet.</p> : (
          <table className="text-sm">
            <thead><tr className="text-left"><th>Number</th><th>Customer</th><th>Total</th><th>Still owed</th><th>Due</th><th></th></tr></thead>
            <tbody>{list.map((i) => (
              <tr key={i.invoiceId} className={i.status === 'overdue' ? 'text-red-700' : ''}>
                <td><a className="text-blue-800 underline" href={`/${slug}/d/${i.shareCode}`}>{i.number}</a></td>
                <td><a className="underline" href={`/${slug}/app/customers/${i.customerId}`}>{i.customerName}</a></td>
                <td>{formatCedis(i.totalPesewas)}</td><td>{formatCedis(i.owedPesewas)}</td><td>{i.dueDate}</td><td>{STATUS[i.status]}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </main>
  );
}
