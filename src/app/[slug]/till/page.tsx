import { cookies } from 'next/headers';
import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { DEVICE_COOKIE } from '@/lib/cookies';
import { findDeviceRegister, listTillStaff } from '@/server/devices';
import { pinAction } from './actions';

export default async function TillPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const token = (await cookies()).get(DEVICE_COOKIE)?.value;
  const device = await findDeviceRegister(getDb(), token);
  if (!device || device.slug !== slug) {
    return <main className="p-8">This device is not registered as a till. Ask a manager to register it.</main>;
  }
  const staff = (await listTillStaff(getDb(), token)) ?? [];
  return (
    <main className="mx-auto flex max-w-sm flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">{device.registerName}</h1>
      <ActionForm action={pinAction.bind(null, slug)} submitLabel="Start selling">
        <fieldset className="grid grid-cols-2 gap-2">
          <legend className="mb-2 text-sm">Who is selling?</legend>
          {staff.map((s, i) => (
            <label key={s.id} className="flex items-center gap-2 rounded border p-3">
              <input type="radio" name="staffId" value={s.id} required defaultChecked={i === 0 && staff.length === 1} /> {s.name}
            </label>
          ))}
        </fieldset>
        <Field label="PIN" name="pin" type="password" inputMode="numeric" pattern="\d{4,6}" autoComplete="off" />
      </ActionForm>
      <a href={`/${slug}/login`} className="text-sm text-blue-800 underline">Sign in with a password instead</a>
    </main>
  );
}
