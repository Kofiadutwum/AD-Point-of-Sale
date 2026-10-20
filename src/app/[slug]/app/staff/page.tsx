import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { PERMISSION_LABELS } from '@/lib/permission-labels';
import { PERMISSIONS } from '@/lib/permissions';
import { listBranches } from '@/server/branches';
import { listStaff } from '@/server/staff';
import { pageCtx } from '../page-ctx';
import { addStaffAction, deactivateAction, permissionsAction, resetAccessAction } from './actions';

export default async function StaffPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'manage_staff');
  const [staff, branchList] = await Promise.all([listStaff(getDb(), ctx), listBranches(getDb(), ctx)]);
  const branchName = new Map(branchList.map((b) => [b.id, b.name]));
  return (
    <main className="flex flex-col gap-8">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <section>
        <h1 className="mb-3 text-2xl font-semibold">Staff</h1>
        <ul className="flex flex-col gap-4">
          {staff.map((s) => (
            <li key={s.id} className="rounded border p-3">
              <p className="font-medium">{s.name} <span className="text-sm text-gray-600">· {s.rolePreset} · {s.status}</span></p>
              <p className="text-sm text-gray-700">{[s.email, s.phone].filter(Boolean).join(' · ')} · {s.branchIds.map((id) => branchName.get(id)).join(', ')}</p>
              {s.rolePreset !== 'owner' && s.id !== ctx.userId && (
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-blue-800">Manage</summary>
                  <div className="mt-3 flex flex-col gap-4">
                    <ActionForm action={resetAccessAction.bind(null, slug, s.id)} submitLabel="Reset access (new invite link)"><span /></ActionForm>
                    {s.status !== 'inactive' && (
                      <ActionForm action={deactivateAction.bind(null, slug, s.id)} submitLabel="Deactivate">
                        <Field label="Reason" name="reason" />
                      </ActionForm>
                    )}
                    <ActionForm action={permissionsAction.bind(null, slug, s.id)} submitLabel="Save permissions">
                      {PERMISSIONS.filter((p) => ctx.permissions.includes(p)).map((p) => (
                        <label key={p} className="flex gap-2">
                          <input type="checkbox" name="permissions" value={p} defaultChecked={s.permissions.includes(p)} /> {PERMISSION_LABELS[p]}
                        </label>
                      ))}
                    </ActionForm>
                  </div>
                </details>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="max-w-md">
        <h2 className="mb-3 text-lg font-semibold">Add staff</h2>
        <ActionForm action={addStaffAction.bind(null, slug)} submitLabel="Add staff">
          <Field label="Name" name="name" />
          <Field label="Phone" name="phone" type="tel" required={false} />
          <Field label="Email" name="email" type="email" required={false} />
          <label className="flex flex-col gap-1 text-sm">Role
            <select name="rolePreset" className="rounded border border-gray-400 px-3 py-2">
              <option value="cashier">Cashier</option><option value="manager">Manager</option>
            </select>
          </label>
          <fieldset className="flex flex-col gap-1 text-sm">
            <legend>Branches</legend>
            {branchList.map((b) => (
              <label key={b.id} className="flex gap-2"><input type="checkbox" name="branchIds" value={b.id} defaultChecked={branchList.length === 1} /> {b.name}</label>
            ))}
          </fieldset>
        </ActionForm>
      </section>
    </main>
  );
}
