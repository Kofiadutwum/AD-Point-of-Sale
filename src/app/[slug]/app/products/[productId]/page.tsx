import { notFound } from 'next/navigation';
import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { listPriceLists } from '@/server/price-lists';
import { getProduct, listCategories } from '@/server/products';
import { getSellingSettings } from '@/server/shop-settings';
import { listTaxRules } from '@/server/tax-rules';
import { variantCost } from '@/server/variants';
import { pageCtx } from '../../page-ctx';
import { ProductFieldsInputs } from '../product-fields';
import { addVariantAction, setProductStatusAction, updateProductAction } from './actions';
import { VariantSection } from './variant-section';

export default async function ProductPage({ params }: { params: Promise<{ slug: string; productId: string }> }) {
  const { slug, productId } = await params;
  const ctx = await pageCtx(slug, 'manage_products');
  const [product, cats, rules, selling, lists] = await Promise.all([
    getProduct(getDb(), ctx, productId), listCategories(getDb(), ctx), listTaxRules(getDb(), ctx), getSellingSettings(getDb(), ctx),
    listPriceLists(getDb(), ctx),
  ]);
  if (!product) notFound();
  const archived = product.status === 'archived';
  const costs = new Map(await Promise.all(product.variants.filter((v) => v.kind !== 'standard')
    .map(async (v) => [v.id, await variantCost(getDb(), ctx, v.id)] as const)));
  return (
    <main className="flex flex-col gap-8">
      <a href={`/${slug}/app/products`} className="text-sm text-blue-800 underline">← Products</a>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{product.name}{archived && <span className="ml-2 text-base text-gray-600">(archived)</span>}</h1>
        <ActionForm action={setProductStatusAction.bind(null, slug, productId, archived ? 'active' : 'archived')} submitLabel={archived ? 'Restore' : 'Archive'}>
          <span />
        </ActionForm>
      </header>
      <section className="max-w-md">
        <h2 className="mb-3 text-lg font-semibold">Details</h2>
        <ActionForm action={updateProductAction.bind(null, slug, productId)} submitLabel="Save">
          <ProductFieldsInputs product={product} categories={cats} taxRules={rules} modules={selling.modules} />
        </ActionForm>
      </section>
      <section className="flex max-w-2xl flex-col gap-4">
        <h2 className="text-lg font-semibold">Variants</h2>
        {product.variants.map((v) => (
          <VariantSection key={v.id} slug={slug} productId={productId} variant={v} cost={costs.get(v.id) ?? null}
            scaleOn={selling.scaleLayout !== null} lists={lists} />
        ))}
        <details className="max-w-md">
          <summary className="cursor-pointer text-sm text-blue-800">Add a variant (size, colour, flavour…)</summary>
          <ActionForm action={addVariantAction.bind(null, slug, productId)} submitLabel="Add variant">
            <Field label="Variant name (e.g. Red, Large)" name="name" />
            <Field label="Selling price (GHS)" name="price" inputMode="decimal" />
            <Field label="Cost per base unit (GHS)" name="cost" inputMode="decimal" defaultValue="0" />
            <Field label="SKU" name="sku" required={false} />
            <label className="flex flex-col gap-1 text-sm">Barcodes (one per line)
              <textarea name="barcodes" rows={2} className="rounded border border-gray-400 px-3 py-2" />
            </label>
            {selling.scaleLayout && <Field label="Scale item code" name="scaleItemCode" inputMode="numeric" required={false} />}
          </ActionForm>
        </details>
      </section>
    </main>
  );
}
