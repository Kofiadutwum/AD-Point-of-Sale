import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import { orderableItems, publicOrderOptions, verifiedPhone } from '@/server/online-orders';
import { publicStorefront } from '@/server/storefront';
import { Pager } from '../storefront-parts';
import { OrderForm } from './order-form';
import { orderTokenCookie } from './token';

export const metadata = { robots: { index: false } };

/** Spec 6.49: the storefront's order page; ?src=whatsapp|instagram|facebook tags where the visitor came from. */
export default async function OrderPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ src?: string; q?: string; page?: string }> }) {
  const { slug } = await params;
  const { src, q, page: pageParam } = await searchParams;
  const page = Math.max(0, (Number.parseInt(pageParam ?? '1', 10) || 1) - 1);
  const now = new Date();
  const [shop, options] = await Promise.all([publicStorefront(getDb(), slug, now, { count: false }), publicOrderOptions(getDb(), slug, now)]);
  if (!shop || !options) notFound();
  const phone = await verifiedPhone(getDb(), slug, (await cookies()).get(orderTokenCookie(slug))?.value, now);
  const found = await orderableItems(getDb(), slug, now, { q, page });
  const items = found.items.map((v) => ({ id: v.variantId, productId: v.productId, name: v.name, pricePesewas: v.pricePesewas, /* an order page always shows what will be charged */ inStock: shop.settings.showStock ? v.inStock : null }));
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-4" style={{ ['--brand' as string]: shop.settings.themeColor }}>
      <a href={`/${slug}`} className="text-sm underline">← {shop.name}</a>
      <h1 className="text-2xl font-semibold">Order from {shop.name}</h1>
      <form role="search" className="flex gap-2">
        {src && <input type="hidden" name="src" value={src} />}
        <input name="q" defaultValue={q} placeholder="Search the menu or products" aria-label="Search" className="min-w-0 flex-1 rounded border border-gray-400 px-3 py-2" />
        <button type="submit" className="rounded px-4 py-2 text-white" style={{ background: 'var(--brand)' }}>Find</button>
      </form>
      {items.length === 0 && !q && page === 0 ? <p>Nothing can be ordered online right now.</p>
        : <OrderForm slug={slug} items={items} options={options} verifiedPhone={phone} source={['whatsapp', 'instagram', 'facebook'].includes(src ?? '') ? src! : 'storefront'} />}
      <Pager base={`/${slug}/order`} params={{ src, q }} page={page} hasMore={found.hasMore} />
    </main>
  );
}
