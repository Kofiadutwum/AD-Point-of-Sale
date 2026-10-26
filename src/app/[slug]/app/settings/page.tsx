import { ActionForm, Check, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { listBranches } from '@/server/branches';
import { getShopProfile } from '@/server/onboarding';
import { MODULE_LABELS } from '@/lib/permission-labels';
import { MODULES } from '@/lib/permissions';
import { effectiveRateBp } from '@/lib/tax';
import { getOfflineEnabled, getSalesSettings, getSellingSettings } from '@/server/shop-settings';
import { listTaxRules, type TaxRule } from '@/server/tax-rules';
import { pageCtx } from '../page-ctx';
import { addBranchAction, addRegisterAction, saveOfflineAction, saveProfileAction, saveSalesAction, saveSellingAction, saveTaxRuleAction } from './actions';

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const [p, branchList, selling, rules, offline, salesSettings] = await Promise.all([
    getShopProfile(getDb(), ctx), listBranches(getDb(), ctx), getSellingSettings(getDb(), ctx), listTaxRules(getDb(), ctx), getOfflineEnabled(getDb(), ctx),
    getSalesSettings(getDb(), ctx),
  ]);
  const scale = selling.scaleLayout;
  return (
    <main className="flex flex-col gap-8">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <section className="max-w-md">
        <h1 className="mb-3 text-2xl font-semibold">Shop settings</h1>
        <ActionForm action={saveProfileAction.bind(null, slug)} submitLabel="Save">
          <Field label="Shop name" name="name" defaultValue={p.name} />
          <Field label="Address" name="address" defaultValue={p.address} required={false} />
          <Field label="Shop phone" name="phone" type="tel" defaultValue={p.phone} required={false} />
          <Field label="Manager phone (for reports)" name="managerPhone" type="tel" defaultValue={p.managerPhone} required={false} />
          <label className="flex flex-col gap-1 text-sm">Prices
            <select name="taxMode" defaultValue={p.taxMode} className="rounded border border-gray-400 px-3 py-2">
              <option value="inclusive">Include tax (shelf price is the final price)</option>
              <option value="exclusive">Add tax at the till</option>
            </select>
          </label>
          <Field label="Business day ends at (HH:MM)" name="businessDayCutoff" defaultValue={p.businessDayCutoff} pattern="([01]\d|2[0-3]):[0-5]\d" />
        </ActionForm>
      </section>
      <section className="max-w-md">
        <h2 className="mb-3 text-lg font-semibold">Offline selling</h2>
        <ActionForm action={saveOfflineAction.bind(null, slug)} submitLabel="Save offline setting">
          <Check name="offlineEnabled" label="Allow tills to sell for cash and manual payments when the internet is down (up to 72 hours)" defaultChecked={offline} />
        </ActionForm>
      </section>
      <section className="max-w-md">
        <h2 className="mb-3 text-lg font-semibold">Selling</h2>
        <ActionForm action={saveSellingAction.bind(null, slug)} submitLabel="Save selling settings">
          <Check name="taxEnabled" label="Charge tax (untick if the shop is not VAT-registered)" defaultChecked={selling.taxEnabled} />
          <fieldset className="flex flex-col gap-2 rounded border p-3">
            <legend className="text-sm font-medium">Scale labels</legend>
            <label className="flex flex-col gap-1 text-sm">Labels carry
              <select name="scaleCarries" defaultValue={scale?.carries ?? 'off'} className="rounded border border-gray-400 px-3 py-2">
                <option value="off">Off (no scale labels)</option>
                <option value="weight">Weight in grams</option>
                <option value="price">Price in pesewas</option>
              </select>
            </label>
            <Field label="Prefix (starts with 2, e.g. 21)" name="scalePrefix" defaultValue={scale?.prefix ?? '21'} required={false} />
            <Field label="Item code starts at digit" name="itemFrom" type="number" defaultValue={(scale?.itemStart ?? 2) + 1} required={false} />
            <Field label="Item code length" name="itemLength" type="number" defaultValue={scale?.itemLength ?? 5} required={false} />
            <Field label="Value starts at digit" name="valueFrom" type="number" defaultValue={(scale?.valueStart ?? 7) + 1} required={false} />
            <Field label="Value length" name="valueLength" type="number" defaultValue={scale?.valueLength ?? 5} required={false} />
          </fieldset>
          <fieldset className="flex flex-col gap-1 rounded border p-3">
            <legend className="text-sm font-medium">Modules</legend>
            {MODULES.map((m) => (
              <Check key={m} name="modules" value={m} label={MODULE_LABELS[m]} defaultChecked={selling.modules.includes(m)} />
            ))}
          </fieldset>
        </ActionForm>
      </section>
      <section className="max-w-md">
        <h2 className="mb-3 text-lg font-semibold">Sales and receipts</h2>
        <ActionForm action={saveSalesAction.bind(null, slug)} submitLabel="Save sales settings">
          <Check name="allowNegativeStock" label="Allow selling when recorded stock is zero (the manager is alerted)" defaultChecked={salesSettings.allowNegativeStock} />
          <Field label="TIN or VAT number on receipts" name="taxNumber" required={false} maxLength={30} defaultValue={salesSettings.taxNumber ?? ''} />
          <Field label="Receipt footer (return policy)" name="receiptFooter" required={false} maxLength={300} defaultValue={salesSettings.receiptFooter ?? ''} />
        </ActionForm>
      </section>
      <section className="flex max-w-md flex-col gap-4">
        <h2 className="text-lg font-semibold">Tax rules</h2>
        {rules.length === 0 && <p className="text-sm text-gray-700">No tax rules yet. Rates are set by the shop; confirm current GRA rates.</p>}
        {rules.map((r) => (
          <details key={r.id} className="rounded border p-3">
            <summary className="cursor-pointer text-sm">
              {r.name} — {effectiveRateBp(r) / 100}%{r.isDefault ? ' (default)' : ''}{r.active ? '' : ' (off)'}
            </summary>
            <TaxRuleForm slug={slug} rule={r} />
          </details>
        ))}
        <h3 className="font-medium">Add a tax rule</h3>
        <TaxRuleForm slug={slug} rule={null} />
      </section>
      <section className="flex max-w-md flex-col gap-4">
        <h2 className="text-lg font-semibold">Branches and tills</h2>
        <ul className="text-sm">
          {branchList.map((b) => (
            <li key={b.id} className="mb-2">
              <span className="font-medium">{b.name}</span> ({b.branchCode}) — tills: {b.registers.map((r) => `${r.name} (${r.registerCode})`).join(', ') || 'none'}
            </li>
          ))}
        </ul>
        <ActionForm action={addBranchAction.bind(null, slug)} submitLabel="Add branch">
          <Field label="Branch name" name="name" />
          <Field label="Branch code (up to 6 letters or numbers, e.g. KSI1)" name="code" />
          <Field label="Address" name="address" required={false} />
          <Field label="Phone" name="phone" type="tel" required={false} />
        </ActionForm>
        <ActionForm action={addRegisterAction.bind(null, slug)} submitLabel="Add till">
          <label className="flex flex-col gap-1 text-sm">Branch
            <select name="branchId" className="rounded border border-gray-400 px-3 py-2">
              {branchList.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <Field label="Till name" name="name" />
          <Field label="Till code (e.g. T2)" name="code" />
        </ActionForm>
      </section>
    </main>
  );
}

function TaxRuleForm({ slug, rule }: { slug: string; rule: TaxRule | null }) {
  const percent = (bp: number | undefined) => (bp === undefined ? '' : String(bp / 100));
  return (
    <ActionForm action={saveTaxRuleAction.bind(null, slug)} submitLabel={rule ? 'Save rule' : 'Add rule'}>
      {rule && <input type="hidden" name="id" value={rule.id} />}
      <Field label="Name (e.g. VAT)" name="name" defaultValue={rule?.name} />
      <Field label="Rate %" name="rate" inputMode="decimal" defaultValue={percent(rule?.rateBp)} />
      {[1, 2, 3].map((i) => (
        <div key={i} className="grid grid-cols-2 gap-2">
          <Field label={`Levy ${i} name`} name={`levyName${i}`} defaultValue={rule?.levies[i - 1]?.name} required={false} />
          <Field label="Levy rate %" name={`levyRate${i}`} inputMode="decimal" defaultValue={percent(rule?.levies[i - 1]?.rateBp)} required={false} />
        </div>
      ))}
      <Check name="vatOnLevies" label="VAT is charged on the levies too" defaultChecked={rule?.vatOnLevies ?? false} />
      <Check name="isDefault" label="Default for products" defaultChecked={rule?.isDefault ?? false} />
      <Check name="active" label="Active" defaultChecked={rule?.active ?? true} />
    </ActionForm>
  );
}
