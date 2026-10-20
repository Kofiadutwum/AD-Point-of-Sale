import { ActionForm } from '@/components/form';
import { getDb } from '@/db/client';
import { listBranches } from '@/server/branches';
import { pageCtx } from '../page-ctx';
import { deregisterDeviceAction, registerDeviceAction } from './actions';

export default async function DevicesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'manage_devices');
  const branchList = await listBranches(getDb(), ctx);
  return (
    <main className="flex flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Till devices</h1>
      <p className="text-sm text-gray-700">Open this page on the phone, tablet, or computer you sell from, then choose its till. Registering a till again moves it to the new device.</p>
      {branchList.map((b) => (
        <section key={b.id} className="flex flex-col gap-3">
          <h2 className="font-semibold">{b.name}</h2>
          {b.registers.filter((r) => r.status === 'active').map((r) => (
            <div key={r.id} className="rounded border p-3">
              <p className="text-sm">{r.name} ({r.registerCode}) · {r.deviceRegisteredAt ? `registered ${r.deviceRegisteredAt.toISOString().slice(0, 10)}` : 'no device yet'}</p>
              <ActionForm action={registerDeviceAction.bind(null, slug, r.id)} submitLabel={`Use this device as ${r.name}`}><span /></ActionForm>
              {r.deviceRegisteredAt && (
                <ActionForm action={deregisterDeviceAction.bind(null, slug, r.id)} submitLabel="Remove device (lost or stolen)"><span /></ActionForm>
              )}
            </div>
          ))}
        </section>
      ))}
      <a href={`/${slug}/till`} className="text-sm text-blue-800 underline">Open the till PIN screen</a>
    </main>
  );
}
