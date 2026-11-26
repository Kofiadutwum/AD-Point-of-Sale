import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import { publicOrderOptions } from '@/server/online-orders';
import { publicStorefront } from '@/server/storefront';
import { ProductCard, ShopHeader } from './storefront-parts';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ q?: string; category?: string }> };

const appUrl = () => process.env.APP_URL ?? 'http://localhost:3000';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const shop = await publicStorefront(getDb(), slug, new Date(), { count: false });
  if (!shop) return { title: 'Not available', robots: { index: false } };
  const image = shop.products.find((p) => p.imageIds.length)?.imageIds[0];
  return {
    title: shop.name, description: shop.settings.about || `Shop ${shop.name} and order on WhatsApp.`,
    openGraph: { title: shop.name, description: shop.settings.about || undefined, url: `${appUrl()}/${slug}`, images: image ? [`${appUrl()}/${slug}/i/${image}`] : undefined },
  };
}

/** Spec 4.12, 6.18: the shop's public page, built from the POS catalogue. */
export default async function StorefrontPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { q, category } = await searchParams;
  const shop = await publicStorefront(getDb(), slug, new Date(), { q: q?.slice(0, 60) || undefined, category: category || undefined });
  if (!shop) notFound();
  const ordering = await publicOrderOptions(getDb(), slug, new Date());
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4" style={{ ['--brand' as string]: shop.settings.themeColor }}>
      <ShopHeader shop={shop} />
      {ordering && <a href={`/${slug}/order`} className="self-start rounded px-4 py-2 font-semibold text-white" style={{ background: 'var(--brand)' }}>Order online</a>}
      <form className="flex flex-wrap gap-2" role="search">
        <input name="q" defaultValue={q} placeholder="Search products" className="min-w-0 flex-1 rounded border border-gray-400 px-3 py-2" aria-label="Search products" />
        {shop.categories.length > 0 && (
          <select name="category" defaultValue={category ?? ''} className="rounded border border-gray-400 px-3 py-2" aria-label="Category">
            <option value="">All</option>{shop.categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <button type="submit" className="rounded px-4 py-2 text-white" style={{ background: 'var(--brand)' }}>Find</button>
      </form>
      {shop.products.length === 0 ? <p className="text-gray-700">No products found.</p> : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">{shop.products.map((p) => <li key={p.id}><ProductCard slug={slug} product={p} /></li>)}</ul>
      )}
      <footer className="mt-6 border-t pt-3 text-xs text-gray-600">
        <a className="underline" href={`mailto:${process.env.REPORT_EMAIL ?? 'report@example.com'}?subject=${encodeURIComponent(`Report storefront /${slug}`)}`}>Report this page</a>
      </footer>
    </main>
  );
}
