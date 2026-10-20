import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { listBranches } from '@/server/branches';
import { getShopProfile } from '@/server/onboarding';
import { pageCtx } from '../page-ctx';
import { addBranchAction, addRegisterAction, saveProfileAction } from './actions';

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const [p, branchList] = await Promise.all([getShopProfile(getDb(), ctx), listBranches(getDb(), ctx)]);
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
