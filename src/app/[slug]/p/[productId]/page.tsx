import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import { publicProduct } from '@/server/storefront';
import { Availability, Price, ShopHeader } from '../../storefront-parts';

type Props = { params: Promise<{ slug: string; productId: string }> };
const appUrl = () => process.env.APP_URL ?? 'http://localhost:3000';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, productId } = await params;
  const r = await publicProduct(getDb(), slug, productId, new Date(), false);
  if (!r) return { title: 'Not available', robots: { index: false } };
  const image = r.product.imageIds[0];
  return {
    title: `${r.product.name} · ${r.shop.name}`, description: r.product.description ?? undefined,
    openGraph: { title: r.product.name, description: r.product.description ?? undefined, url: `${appUrl()}/${slug}/p/${productId}`, images: image ? [`${appUrl()}/${slug}/i/${image}`] : undefined },
  };
}

/** Spec 6.18, 6.19: a product with photos and "Order on WhatsApp" / "Call"; prescription-only medicine shows "Ask at the pharmacy". */
export default async function StorefrontProductPage({ params }: Props) {
  const { slug, productId } = await params;
  const r = await publicProduct(getDb(), slug, productId, new Date());
  if (!r) notFound();
  const { shop, product } = r;
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4" style={{ ['--brand' as string]: shop.settings.themeColor }}>
      <ShopHeader shop={shop} />
      <article className="flex flex-col gap-3">
        <div className="flex snap-x gap-2 overflow-x-auto">
          {product.imageIds.map((id, i) => (
            <img key={id} src={`/${slug}/i/${id}`} alt={i === 0 ? product.name : ''} loading={i === 0 ? 'eager' : 'lazy'} className="aspect-square w-64 shrink-0 snap-start rounded object-cover" />
          ))}
        </div>
        <h2 className="text-xl font-semibold">{product.name}</h2>
        {product.category && <p className="text-sm text-gray-700">{product.category}</p>}
        <p className="flex gap-3"><Price product={product} /><Availability product={product} /></p>
        {product.description && <p className="whitespace-pre-wrap text-sm">{product.description}</p>}
        {product.prescriptionOnly ? (
          <p className="rounded border border-amber-600 p-2 text-sm">Prescription medicine: ask at the pharmacy.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {shop.settings.whatsapp && <a className="rounded bg-green-700 px-4 py-3 text-white" href={`/${slug}/go/whatsapp?product=${product.id}`}>Order on WhatsApp</a>}
            {shop.phone && <a className="rounded border border-gray-500 px-4 py-3" href={`/${slug}/go/call?product=${product.id}`}>Call</a>}
          </div>
        )}
      </article>
    </main>
  );
}
