import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { listCustomers } from '@/server/customers';
import { listPriceLists } from '@/server/price-lists';
import { pageCtx } from '../page-ctx';
import { addCustomerAction, storeCreditAction } from './actions';

export default async function CustomersPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ q?: string; page?: string }> }) {
  const { slug } = await params;
  const { q, page: pageParam } = await searchParams;
  const page = Math.max(0, (Number.parseInt(pageParam ?? '1', 10) || 1) - 1);
  const PAGE = 50;
  const ctx = await pageCtx(slug, 'make_sale');
  const canCredit = ctx.permissions.includes('approve_actions');
  const lists = ctx.permissions.includes('manage_products') ? await listPriceLists(getDb(), ctx) : [];
  const rows = await listCustomers(getDb(), ctx, { query: q, limit: PAGE + 1, offset: page * PAGE }); // one extra row says whether a next page exists
  const found = rows.slice(0, PAGE);
  const href = (p: number) => { const sp = new URLSearchParams(); if (q) sp.set('q', q); if (p > 0) sp.set('page', String(p + 1)); const s = sp.toString(); return `/${slug}/app/customers${s ? `?${s}` : ''}`; };
  return (
    <main className="flex flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Customers</h1>
      <a href={`/${slug}/app/customers/owing`} className="text-sm text-blue-800 underline">Who owes</a>
      <form className="flex gap-2">
        <input name="q" defaultValue={q} placeholder="Name or phone" aria-label="Search" className="min-w-0 flex-1 rounded border border-gray-400 px-3 py-2" />
        <button type="submit" className="rounded border px-4 py-2">Search</button>
      </form>
      <ul className="divide-y rounded border">
        {found.map((c) => (
          <li key={c.id} className="flex flex-col gap-2 p-3">
            <span className="flex justify-between"><span>{c.name} · {c.phone} · <a className="text-blue-800 underline" href={`/${slug}/app/customers/${c.id}`}>Account</a></span><span>Store credit {formatCedis(c.storeCreditPesewas)}</span></span>
            {canCredit && (
              <details>
                <summary className="cursor-pointer text-sm text-blue-800">Give store credit</summary>
                <ActionForm action={storeCreditAction.bind(null, slug, c.id)} submitLabel="Give credit">
                  <Field label="Amount (GHS)" name="amount" inputMode="decimal" />
                  <label className="flex flex-col gap-1 text-sm">Why
                    <select name="source" className="rounded border border-gray-400 px-3 py-2"><option value="goodwill">Goodwill</option><option value="refund">Refund</option></select>
                  </label>
                  <Field label="Reason" name="reason" maxLength={200} />
                </ActionForm>
              </details>
            )}
          </li>
        ))}
        {found.length === 0 && <li className="p-3 text-sm text-gray-600">No customers found.</li>}
      </ul>
      {(page > 0 || rows.length > PAGE) && (
        <nav aria-label="Pages" className="flex items-center justify-between text-sm">
          {page > 0 ? <a className="rounded border px-3 py-2" href={href(page - 1)}>← Previous</a> : <span />}
          <span>Page {page + 1}</span>
          {rows.length > PAGE ? <a className="rounded border px-3 py-2" href={href(page + 1)}>Next →</a> : <span />}
        </nav>
      )}
      <section className="max-w-md">
        <h2 className="mb-3 text-lg font-semibold">Add a customer</h2>
        <ActionForm action={addCustomerAction.bind(null, slug)} submitLabel="Add customer">
          <Field label="Name" name="name" maxLength={80} />
          <Field label="Phone" name="phone" type="tel" />
          {lists.length > 0 && (
            <label className="flex flex-col gap-1 text-sm">Price list
              <select name="priceListId" className="rounded border border-gray-400 px-3 py-2">
                <option value="">Default</option>
                {lists.filter((l) => l.kind !== 'retail' && l.kind !== 'branch').map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
          )}
        </ActionForm>
      </section>
    </main>
  );
}
