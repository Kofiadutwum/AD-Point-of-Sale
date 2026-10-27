import { ActionForm, Check, Field } from '@/components/form';
import { formatCedis } from '@/lib/money';
import type { PriceListView } from '@/server/price-lists';
import type { ProductDetail } from '@/server/products';
import { cediText } from '../form-data';
import {
  addBarcodeAction, addComponentAction, addUnitAction, removeBarcodeAction, removeComponentAction, removeListPriceAction, removeUnitAction,
  setListPriceAction, setVariantStatusAction,
  updateUnitAction, updateVariantAction,
} from './actions';

type Variant = ProductDetail['variants'][number];

/** One variant: its fields, units with their barcodes, and (for bundles and recipes) its parts and their cost. */
export function VariantSection({ slug, productId, variant: v, cost, scaleOn, kitchenOn = false, lists }: {
  slug: string; productId: string; variant: Variant; cost: string | null; scaleOn: boolean; kitchenOn?: boolean; lists: PriceListView[];
}) {
  const ids = [slug, productId] as const;
  const costText = cediText(Math.round(Number(v.averageCost)));
  const archived = v.status === 'archived';
  return (
    <section className="flex flex-col gap-4 rounded border p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{v.name || 'Default variant'}{archived && ' (archived)'} · {v.kind}</h3>
        <ActionForm action={setVariantStatusAction.bind(null, ...ids, v.id, archived ? 'active' : 'archived')} submitLabel={archived ? 'Restore variant' : 'Archive variant'}>
          <span />
        </ActionForm>
      </header>
      <details>
        <summary className="cursor-pointer text-sm text-blue-800">Edit price, SKU, and settings</summary>
        <ActionForm action={updateVariantAction.bind(null, ...ids, v.id)} submitLabel="Save variant">
          <Field label="Variant name (e.g. Red, Large)" name="name" defaultValue={v.name} required={false} />
          <Field label="SKU" name="sku" defaultValue={v.sku ?? ''} required={false} />
          <Field label="Selling price per base unit (GHS)" name="price" inputMode="decimal" defaultValue={cediText(v.basePricePesewas)} />
          <Field label="Cost per base unit (GHS)" name="cost" inputMode="decimal" defaultValue={costText} />
          <input type="hidden" name="costShown" value={costText} />
          <Field label="Reorder level" name="reorderLevel" inputMode="decimal" defaultValue={v.reorderLevel ?? ''} required={false} />
          {scaleOn && <Field label="Scale item code" name="scaleItemCode" inputMode="numeric" defaultValue={v.scaleItemCode ?? ''} required={false} />}
          <Check name="allowsFractions" label="Sold in fractions" defaultChecked={v.allowsFractions} />
          <Check name="sellable" label="Sold on its own (untick for ingredients)" defaultChecked={v.sellable} />
          {kitchenOn && <>
            <input type="hidden" name="needsPackShown" value="1" />
            <Check name="needsPack" label="Takeaway needs a pack for each one" defaultChecked={v.needsPack} />
            {(v.kind === 'standard' || v.kind === 'recipe') && <>
              <Check name="sellByAmount" label="Sell by amount (rice, stew, waakye)" defaultChecked={v.sellByAmount} />
              <Field label="Minimum amount (GHS)" name="minAmount" inputMode="decimal" defaultValue={v.minAmountPesewas ? (v.minAmountPesewas / 100).toFixed(2) : ''} required={false} />
              <Field label="Value of one pot (GHS, for the pot check)" name="valuePerPot" inputMode="decimal" defaultValue={v.valuePerPotPesewas ? (v.valuePerPotPesewas / 100).toFixed(2) : ''} required={false} />
            </>}
          </>}
        </ActionForm>
      </details>
      <div className="flex flex-col gap-3">
        <h4 className="text-sm font-medium">Units</h4>
        {v.units.map((u) => (
          <div key={u.id} className="rounded border p-3 text-sm">
            <p className="font-medium">
              {u.name}{u.isBase ? ' (base unit)' : ` = ${u.factor} ${v.units[0].name}`}
              {' · '}{u.pricePesewas === null ? 'price from base price' : formatCedis(u.pricePesewas)}
            </p>
            <ul className="my-2 flex flex-col gap-1">
              {u.barcodes.map((b) => (
                <li key={b.id} className="flex items-center gap-2">
                  <code>{b.code}</code>
                  <ActionForm action={removeBarcodeAction.bind(null, ...ids, b.id)} submitLabel="Remove barcode"><span /></ActionForm>
                </li>
              ))}
            </ul>
            <ActionForm action={addBarcodeAction.bind(null, ...ids, u.id)} submitLabel="Add barcode">
              <Field label="Barcode (scan or type)" name="code" />
            </ActionForm>
            {lists.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-blue-800">List prices</summary>
                <ul className="my-2 flex flex-col gap-1">
                  {lists.flatMap((l) => l.items.filter((i) => i.unitId === u.id).map((i) => (
                    <li key={i.id} className="flex items-center gap-2">
                      <span className="flex-1">{l.name} · from {i.minQuantity}: {formatCedis(i.pricePesewas)}</span>
                      <ActionForm action={removeListPriceAction.bind(null, ...ids, i.id)} submitLabel="Remove"><span /></ActionForm>
                    </li>
                  )))}
                </ul>
                <ActionForm action={setListPriceAction.bind(null, ...ids, u.id)} submitLabel="Save list price">
                  <label className="flex flex-col gap-1 text-sm">List
                    <select name="priceListId" className="rounded border border-gray-400 px-3 py-2">
                      {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  </label>
                  <Field label={`From quantity (${u.name})`} name="minQuantity" inputMode="decimal" defaultValue="1" />
                  <Field label="Price each (GHS)" name="price" inputMode="decimal" />
                </ActionForm>
              </details>
            )}
            <details className="mt-2">
              <summary className="cursor-pointer text-blue-800">Edit unit</summary>
              <ActionForm action={updateUnitAction.bind(null, ...ids, u.id)} submitLabel="Save unit">
                <UnitInputs name={u.name} factor={u.factor} price={u.pricePesewas} sellable={u.sellable} purchasable={u.purchasable} isBase={u.isBase} />
              </ActionForm>
              {!u.isBase && <ActionForm action={removeUnitAction.bind(null, ...ids, u.id)} submitLabel="Remove unit"><span /></ActionForm>}
            </details>
          </div>
        ))}
        <details>
          <summary className="cursor-pointer text-sm text-blue-800">Add a unit (strip, pack, carton…)</summary>
          <ActionForm action={addUnitAction.bind(null, ...ids, v.id)} submitLabel="Add unit">
            <UnitInputs name="" factor="" price={null} sellable purchasable isBase={false} />
          </ActionForm>
        </details>
      </div>
      {v.kind !== 'standard' && (
        <div className="flex flex-col gap-2 text-sm">
          <h4 className="font-medium">{v.kind === 'recipe' ? 'Ingredients' : 'Parts'} · cost {cost === null ? '—' : formatCedis(Math.round(Number(cost)))}</h4>
          <ul className="flex flex-col gap-1">
            {v.components.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <span className="flex-1">{c.quantity} {c.baseUnit} {c.name}</span>
                <ActionForm action={removeComponentAction.bind(null, ...ids, c.id)} submitLabel="Remove"><span /></ActionForm>
              </li>
            ))}
          </ul>
          <ActionForm action={addComponentAction.bind(null, ...ids, v.id)} submitLabel="Add part">
            <Field label="Part SKU or barcode" name="code" />
            <Field label="Quantity in its base unit" name="quantity" inputMode="decimal" defaultValue="1" />
          </ActionForm>
        </div>
      )}
    </section>
  );
}

function UnitInputs({ name, factor, price, sellable, purchasable, isBase }: {
  name: string; factor: string; price: number | null; sellable: boolean; purchasable: boolean; isBase: boolean;
}) {
  return (
    <>
      <Field label="Unit name" name="name" defaultValue={name} />
      {isBase
        ? <input type="hidden" name="factor" value="1" />
        : <Field label="Base units in one of these" name="factor" inputMode="decimal" defaultValue={factor} />}
      {!isBase && <Field label="Own price (GHS; blank = base price × units)" name="price" inputMode="decimal" defaultValue={price === null ? '' : cediText(price)} required={false} />}
      <Check name="sellable" label="Sellable" defaultChecked={sellable} />
      <Check name="purchasable" label="Purchasable" defaultChecked={purchasable} />
    </>
  );
}
