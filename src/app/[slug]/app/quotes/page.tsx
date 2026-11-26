import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { listQuotes } from '@/server/quotes';
import { pageCtx } from '../page-ctx';
import { createQuoteAction } from './actions';
import { ItemRows } from './item-rows';

export default async function QuotesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'make_sale');
  const list = await listQuotes(getDb(), ctx);
  return (
    <main className="flex max-w-2xl flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Quotes</h1>
      <ActionForm action={createQuoteAction.bind(null, slug)} submitLabel="Make quote">
        <ItemRows discounts={ctx.permissions.includes('give_discount')} />
        <Field label="Valid for (days)" name="validDays" type="number" min={1} max={90} defaultValue={7} />
        <Field label="Note (delivery, terms...)" name="note" required={false} maxLength={300} />
      </ActionForm>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Recent quotes</h2>
        {list.length === 0 ? <p className="text-sm text-gray-700">No quotes yet.</p> : (
          <ul className="text-sm">{list.map((q) => (
            <li key={q.id}><a className="text-blue-800 underline" href={`/${slug}/app/quotes/${q.id}`}>{q.number}</a> · {q.customerName ?? 'No customer'} · {formatCedis(q.totalPesewas)} · valid until {q.validUntil} · {q.status}</li>
          ))}</ul>
        )}
      </section>
    </main>
  );
}
