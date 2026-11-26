import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import { orderableItems, publicOrderOptions, verifiedPhone } from '@/server/online-orders';
import { publicStorefront } from '@/server/storefront';
import { OrderForm } from './order-form';
import { orderTokenCookie } from './token';

export const metadata = { robots: { index: false } };

/** Spec 6.49: the storefront's order page; ?src=whatsapp|instagram|facebook tags where the visitor came from. */
export default async function OrderPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ src?: string }> }) {
  const { slug } = await params;
  const { src } = await searchParams;
  const now = new Date();
  const [shop, options] = await Promise.all([publicStorefront(getDb(), slug, now, { count: false }), publicOrderOptions(getDb(), slug, now)]);
  if (!shop || !options) notFound();
  const phone = await verifiedPhone(getDb(), slug, (await cookies()).get(orderTokenCookie(slug))?.value, now);
  const items = (await orderableItems(getDb(), slug, now)).map((v) => ({ id: v.variantId, productId: v.productId, name: v.name, pricePesewas: v.pricePesewas, /* an order page always shows what will be charged */ inStock: shop.settings.showStock ? v.inStock : null }));
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-4" style={{ ['--brand' as string]: shop.settings.themeColor }}>
      <a href={`/${slug}`} className="text-sm underline">← {shop.name}</a>
      <h1 className="text-2xl font-semibold">Order from {shop.name}</h1>
      {items.length === 0 ? <p>Nothing can be ordered online right now.</p>
        : <OrderForm slug={slug} items={items} options={options} verifiedPhone={phone} source={['whatsapp', 'instagram', 'facebook'].includes(src ?? '') ? src! : 'storefront'} />}
    </main>
  );
}
