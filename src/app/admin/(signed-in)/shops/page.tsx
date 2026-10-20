import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { listShops } from '@/server/platform-admin';
import { createShopAction } from './actions';

export default async function AdminShopsPage() {
  const shops = await listShops(getDb(), new Date());
  return (
    <main className="flex flex-col gap-8">
      <section>
        <h1 className="mb-3 text-2xl font-semibold">Shops</h1>
        <table className="w-full text-left text-sm">
          <thead><tr><th>Name</th><th>Address</th><th>Type</th><th>Status</th><th>Subscription</th><th>Ends</th></tr></thead>
          <tbody>
            {shops.map((s) => (
              <tr key={s.tenantId} className="border-t">
                <td><a className="text-blue-800 underline" href={`/admin/shops/${s.tenantId}`}>{s.name}</a></td>
                <td>/{s.slug}</td><td>{s.shopType}</td><td>{s.status}</td><td>{s.state}</td><td>{s.endDate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="max-w-md">
        <h2 className="mb-3 text-lg font-semibold">Create a shop</h2>
        <ActionForm action={createShopAction} submitLabel="Create shop">
          <Field label="Shop name" name="name" />
          <Field label="Shop address (leave blank to use the name)" name="slug" required={false} />
          <label className="flex flex-col gap-1 text-sm">Shop type
            <select name="shopType" className="rounded border border-gray-400 px-3 py-2">
              <option value="retail">Retail</option><option value="pharmacy">Pharmacy</option><option value="food">Food</option>
            </select>
          </label>
          <Field label="Owner name" name="ownerName" />
          <Field label="Owner email" name="ownerEmail" type="email" required={false} />
          <Field label="Owner phone" name="ownerPhone" type="tel" required={false} />
          <fieldset className="flex flex-col gap-2 rounded border p-3 text-sm">
            <legend>Start</legend>
            <label><input type="radio" name="start" value="trial" defaultChecked /> Free trial (14 days)</label>
            <label><input type="radio" name="start" value="paid" /> Paid now</label>
            <select name="method" className="rounded border border-gray-400 px-3 py-2">
              <option value="momo">Mobile money</option><option value="bank_transfer">Bank transfer</option>
              <option value="cash">Cash</option><option value="card_terminal">Card terminal</option>
            </select>
            <Field label="Payment reference" name="reference" required={false} />
            <Field label="Amount (GHS)" name="amount" inputMode="decimal" required={false} />
            <Field label="Months" name="months" type="number" min={1} max={36} defaultValue={12} required={false} />
          </fieldset>
        </ActionForm>
      </section>
    </main>
  );
}
