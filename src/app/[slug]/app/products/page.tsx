import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { itemLabel, listCategories, searchCatalogue } from '@/server/products';
import { pageCtx } from '../page-ctx';
import { addCategoryAction } from './actions';

const PAGE_SIZE = 50;

export default async function ProductsPage({ params, searchParams }: {
  params: Promise<{ slug: string }>; searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await pageCtx(slug, 'manage_products');
  const status = sp.status === 'archived' ? 'archived' : 'active';
  const page = Math.max(1, Math.trunc(Number(sp.page)) || 1);
  const [hits, cats] = await Promise.all([
    searchCatalogue(getDb(), ctx, { query: sp.q, status, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE }),
    listCategories(getDb(), ctx),
  ]);
  const link = (p: number) => `?${new URLSearchParams({ q: sp.q ?? '', status, page: String(p) })}`;
  return (
    <main className="flex flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Products</h1>
        <a href={`/${slug}/app/products/new`} className="rounded bg-blue-800 px-4 py-2 text-white">Add product</a>
      </header>
      <form className="flex flex-wrap gap-2">
        <input name="q" defaultValue={sp.q} placeholder="Name, SKU, barcode, or category" aria-label="Search"
          className="min-w-0 flex-1 rounded border border-gray-400 px-3 py-2" />
        <select name="status" defaultValue={status} aria-label="Status" className="rounded border border-gray-400 px-3 py-2">
          <option value="active">Active</option>
          <option value="archived">Archived</option>
        </select>
        <button type="submit" className="rounded border px-4 py-2">Search</button>
      </form>
      <ul className="divide-y rounded border">
        {hits.slice(0, PAGE_SIZE).map((h) => (
          <li key={h.variantId}>
            <a href={`/${slug}/app/products/${h.productId}`} className="flex items-center gap-3 p-3 hover:bg-gray-50">
              {h.mainImageId
                ? <img src={`/${slug}/app/images/${h.mainImageId}`} alt="" width={48} height={48} loading="lazy" className="h-12 w-12 rounded object-cover" />
                : <span className="h-12 w-12 rounded bg-gray-100" />}
              <span className="flex-1">
                <span className="block font-medium">{itemLabel(h.productName, h.variantName)}</span>
                <span className="text-sm text-gray-600">{h.sku ?? 'No SKU'} · per {h.baseUnit}</span>
              </span>
              <span className="text-sm">{formatCedis(h.basePricePesewas)}</span>
            </a>
          </li>
        ))}
        {hits.length === 0 && <li className="p-3 text-sm text-gray-600">No products found.</li>}
      </ul>
      <nav className="flex gap-3 text-sm">
        {page > 1 && <a href={link(page - 1)} className="text-blue-800 underline">Previous</a>}
        {hits.length > PAGE_SIZE && <a href={link(page + 1)} className="text-blue-800 underline">Next</a>}
      </nav>
      <section className="max-w-md">
        <h2 className="mb-2 text-lg font-semibold">Categories</h2>
        <p className="mb-2 text-sm text-gray-700">{cats.map((c) => c.name).join(', ') || 'None yet.'}</p>
        <ActionForm action={addCategoryAction.bind(null, slug)} submitLabel="Add category">
          <Field label="Category name" name="name" />
        </ActionForm>
      </section>
    </main>
  );
}
