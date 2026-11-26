import { formatCedis } from '@/lib/money';
import type { PublicProduct, PublicShop } from '@/server/storefront';

type Shop = Omit<PublicShop, 'products' | 'categories'>;

export function ShopHeader({ shop }: { shop: Shop }) {
  const s = shop.settings;
  return (
    <header className="flex flex-col gap-2">
      {shop.announcement && <p className="rounded px-3 py-2 text-sm text-white" style={{ background: 'var(--brand)' }}>{shop.announcement}</p>}
      <h1 className="text-2xl font-bold" style={{ color: 'var(--brand)' }}><a href={`/${shop.slug}`}>{shop.name}</a></h1>
      {s.about && <p className="text-sm text-gray-800">{s.about}</p>}
      <p className="text-sm text-gray-700">
        {shop.address && <a className="underline" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(shop.address)}`}>{shop.address}</a>}
        {shop.address && s.hours && ' · '}{s.hours}
      </p>
      <div className="flex flex-wrap gap-2 text-sm">
        {s.whatsapp && <a className="rounded bg-green-700 px-3 py-2 text-white" href={`/${shop.slug}/go/whatsapp`}>WhatsApp us</a>}
        {shop.phone && <a className="rounded border border-gray-500 px-3 py-2" href={`/${shop.slug}/go/call`}>Call</a>}
        {s.facebook && <a className="px-1 py-2 underline" href={s.facebook} rel="noopener noreferrer">Facebook</a>}
        {s.instagram && <a className="px-1 py-2 underline" href={s.instagram} rel="noopener noreferrer">Instagram</a>}
      </div>
    </header>
  );
}

export function Price({ product }: { product: PublicProduct }) {
  return <span className="font-semibold">{product.pricePesewas === null ? 'Call for price' : formatCedis(product.pricePesewas)}</span>;
}

export function Availability({ product }: { product: PublicProduct }) {
  if (product.inStock === null) return null;
  return <span className={product.inStock ? 'text-green-800' : 'text-red-700'}>{product.inStock ? 'In stock' : 'Out of stock'}</span>;
}

export function ProductCard({ slug, product }: { slug: string; product: PublicProduct }) {
  return (
    <a href={`/${slug}/p/${product.id}`} className="flex h-full flex-col gap-1 rounded border border-gray-300 p-2 text-sm">
      {product.imageIds[0]
        ? <img src={`/${slug}/i/${product.imageIds[0]}`} alt={product.name} loading="lazy" className="aspect-square w-full rounded object-cover" />
        : <div className="aspect-square w-full rounded bg-gray-100" aria-hidden />}
      <span className="font-medium">{product.name}{product.featured ? ' ★' : ''}</span>
      <Price product={product} />
      <Availability product={product} />
    </a>
  );
}
