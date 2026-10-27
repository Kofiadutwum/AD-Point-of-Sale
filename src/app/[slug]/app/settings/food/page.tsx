import { ActionForm, Check } from '@/components/form';
import { getDb } from '@/db/client';
import { listBranches } from '@/server/branches';
import { getFoodSettings, listPackChoices } from '@/server/food-settings';
import { pageCtx } from '../../page-ctx';
import { boardLinkAction, saveFoodSettingsAction, saveModesAction } from './actions';

/** Spec 4.24, 6.56: the takeaway pack, service modes per branch, and Ready board links. */
export default async function FoodSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const [settings, choices, branchList] = await Promise.all([getFoodSettings(getDb(), ctx), listPackChoices(getDb(), ctx), listBranches(getDb(), ctx)]);
  return (
    <main className="flex max-w-md flex-col gap-8">
      <a href={`/${slug}/app/settings`} className="text-sm text-blue-800 underline">← Shop settings</a>
      <section>
        <h1 className="mb-3 text-2xl font-semibold">Food settings</h1>
        <ActionForm action={saveFoodSettingsAction.bind(null, slug)} submitLabel="Save">
          <label className="flex flex-col gap-1 text-sm">Takeaway pack item
            <select name="packVariantId" defaultValue={settings.packVariantId ?? ''} className="rounded border border-gray-400 px-3 py-2">
              <option value="">No pack fee</option>
              {choices.map((c) => <option key={c.variantId} value={c.variantId}>{c.label}</option>)}
            </select>
          </label>
          <fieldset className="flex flex-col gap-1 text-sm">
            <legend>Charge the pack</legend>
            <label className="flex items-center gap-2"><input type="radio" name="packFeeMode" value="per_order" defaultChecked={settings.packFeeMode === 'per_order'} /> Per order</label>
            <label className="flex items-center gap-2"><input type="radio" name="packFeeMode" value="per_item" defaultChecked={settings.packFeeMode === 'per_item'} /> Per item that needs a pack</label>
          </fieldset>
        </ActionForm>
      </section>
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Branches</h2>
        {branchList.map((b) => (
          <div key={b.id} className="flex flex-col gap-3 rounded border p-3">
            <h3 className="font-medium">{b.name}</h3>
            <ActionForm action={saveModesAction.bind(null, slug, b.id)} submitLabel="Save service modes">
              <Check name="modes" value="counter" label="Counter (pay first, collect by number)" defaultChecked={b.serviceModes.includes('counter')} />
              <Check name="modes" value="quick" label="Quick serve (pay and go)" defaultChecked={b.serviceModes.includes('quick')} />
              <Check name="modes" value="table" label="Table (waiter tickets, pay at the end)" defaultChecked={b.serviceModes.includes('table')} />
            </ActionForm>
            {ctx.permissions.includes('manage_devices') && <ActionForm action={boardLinkAction.bind(null, slug, b.id)} submitLabel="Create board link">{null}</ActionForm>}
          </div>
        ))}
      </section>
    </main>
  );
}
