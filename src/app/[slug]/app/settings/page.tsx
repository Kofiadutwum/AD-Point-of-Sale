import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { getShopProfile } from '@/server/onboarding';
import { pageCtx } from '../page-ctx';
import { saveProfileAction } from './actions';

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'manage_shop_settings');
  const p = await getShopProfile(getDb(), ctx);
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
    </main>
  );
}
