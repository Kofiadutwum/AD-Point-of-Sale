import { notFound } from 'next/navigation';
import { ActionForm } from '@/components/form';
import { getDb } from '@/db/client';
import { getProduct, listCategories } from '@/server/products';
import { getSellingSettings } from '@/server/shop-settings';
import { listTaxRules } from '@/server/tax-rules';
import { pageCtx } from '../../page-ctx';
import { ProductFieldsInputs } from '../product-fields';
import { setProductStatusAction, updateProductAction } from './actions';

export default async function ProductPage({ params }: { params: Promise<{ slug: string; productId: string }> }) {
  const { slug, productId } = await params;
  const ctx = await pageCtx(slug, 'manage_products');
  const [product, cats, rules, selling] = await Promise.all([
    getProduct(getDb(), ctx, productId), listCategories(getDb(), ctx), listTaxRules(getDb(), ctx), getSellingSettings(getDb(), ctx),
  ]);
  if (!product) notFound();
  const archived = product.status === 'archived';
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
    </main>
  );
}
