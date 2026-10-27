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
import { PhotoUpload } from '@/components/photo-upload';
import { getComboSlots, listChoosableItems } from '@/server/combos';
import { getItemAddOnGroups, listAddOnGroups } from '@/server/add-ons';
import { ComboSlots } from './combo-slots';
import {
  addVariantAction, makeMainPhotoAction, removePhotoAction, setItemAddOnsAction, setProductStatusAction, setStationAction, updateProductAction, uploadPhotoAction,
} from './actions';
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
  const combos = product.variants.filter((v) => v.kind === 'combo');
  const comboSlots = new Map(await Promise.all(combos.map(async (v) => [v.id, await getComboSlots(getDb(), ctx, v.id)] as const)));
  const choosable = combos.length ? await listChoosableItems(getDb(), ctx) : [];
  // spec 4.24: food items other than combos and sell-by-amount items can offer add-on groups
  const addOnItems = selling.modules.includes('kitchen') ? product.variants.filter((v) => v.kind !== 'combo' && !v.sellByAmount) : [];
  const groups = addOnItems.length ? await listAddOnGroups(getDb(), ctx) : [];
  const itemGroups = new Map(await Promise.all(addOnItems.map(async (v) => [v.id, await getItemAddOnGroups(getDb(), ctx, v.id)] as const)));
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
      <section className="flex max-w-2xl flex-col gap-3">
        <h2 className="text-lg font-semibold">Photos</h2>
        <p className="text-sm text-gray-700">Up to 5 photos. The first is the main photo. Photos are stored at 20–30 KB with location data removed.</p>
        <ul className="flex flex-wrap gap-3">
          {product.images.map((img, i) => (
            <li key={img.id} className="flex w-32 flex-col gap-1 text-sm">
              <img src={`/${slug}/app/images/${img.id}`} alt={`${product.name} photo ${i + 1}`} width={128} height={128}
                loading="lazy" className="h-32 w-32 rounded border object-cover" />
              {i === 0
                ? <span className="font-medium">Main photo</span>
                : <ActionForm action={makeMainPhotoAction.bind(null, slug, productId, img.id)} submitLabel="Make main"><span /></ActionForm>}
              <ActionForm action={removePhotoAction.bind(null, slug, productId, img.id)} submitLabel="Remove"><span /></ActionForm>
            </li>
          ))}
        </ul>
        {product.images.length < 5 && <PhotoUpload upload={uploadPhotoAction.bind(null, slug, productId)} />}
      </section>
      <section className="flex max-w-2xl flex-col gap-4">
        <h2 className="text-lg font-semibold">Variants</h2>
        {product.variants.map((v) => (
          <VariantSection key={v.id} slug={slug} productId={productId} variant={v} cost={costs.get(v.id) ?? null}
            scaleOn={selling.scaleLayout !== null} kitchenOn={selling.modules.includes('kitchen')} lists={lists} />
        ))}
        {product.variants.filter((v) => v.kind === 'combo').map((v) => (
          <ComboSlots key={`slots-${v.id}`} slug={slug} productId={productId} variantId={v.id} slots={comboSlots.get(v.id) ?? []} items={choosable} />
        ))}
        {selling.modules.includes('kitchen') && (
          <ActionForm action={setStationAction.bind(null, slug, productId)} submitLabel="Save station">
            <label className="flex flex-col gap-1 text-sm">Table orders go to
              <select name="station" defaultValue={product.kitchenStation} className="rounded border border-gray-400 px-3 py-2">
                <option value="kitchen">Kitchen</option><option value="bar">Bar</option><option value="grill">Grill</option>
              </select>
            </label>
          </ActionForm>
        )}
        {groups.length > 0 && addOnItems.map((v) => (
          <section key={`add-ons-${v.id}`} className="rounded border p-3">
            <h3 className="font-medium">Add-on groups{v.name ? ` · ${v.name}` : ''}</h3>
            <ActionForm action={setItemAddOnsAction.bind(null, slug, productId, v.id)} submitLabel="Save add-ons">
              {groups.map((g) => (
                <label key={g.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="groupId" value={g.id} defaultChecked={itemGroups.get(v.id)?.includes(g.id)} /> {g.name}
                </label>
              ))}
            </ActionForm>
          </section>
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
