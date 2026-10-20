'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { addStaff, deactivateStaff, resetStaffAccess, setStaffBranches, setStaffPermissions } from '@/server/staff';
import { pageCtx } from '../page-ctx';

const MESSAGES: Record<string, string> = {
  limit_reached: 'Your plan allows no more staff. Upgrade to add more.',
  contact_required: 'Enter a valid email or Ghana phone number.',
  duplicate_contact: 'Someone in this shop already uses that email or phone.',
  unknown_branch: 'Choose at least one branch.',
  invalid_input: 'Enter a name and choose a role.',
  not_found: 'That staff member was not found.',
  cannot_change_owner: 'The owner’s access cannot be changed here.',
  cannot_change_self: 'You cannot change your own access.',
  invalid_permission: 'Choose permissions from the list.',
  cannot_grant: 'You can only give permissions you have yourself.',
  cannot_change: 'This person has permissions you do not have. Ask the owner.',
};
const SEND_NOTE = 'Send this link by WhatsApp or SMS:';
const value = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

export async function addStaffAction(slug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_staff');
  const r = await addStaff(getDb(), ctx, {
    name: value(formData, 'name'), email: value(formData, 'email'), phone: value(formData, 'phone'),
    rolePreset: value(formData, 'rolePreset') === 'manager' ? 'manager' : 'cashier',
    branchIds: formData.getAll('branchIds').map(String),
  }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/staff`);
  return { error: null, message: `Added. ${SEND_NOTE}`, copy: r.inviteUrl };
}

export async function resetAccessAction(slug: string, staffId: string, _prev: FormState, _formData: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_staff', { allowReadOnly: true });
  const r = await resetStaffAccess(getDb(), ctx, staffId, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/staff`);
  return { error: null, message: `Access reset. ${SEND_NOTE}`, copy: r.inviteUrl };
}

export async function deactivateAction(slug: string, staffId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_staff', { allowReadOnly: true });
  const reason = value(formData, 'reason');
  if (!reason) return { error: 'Give a reason.' };
  const r = await deactivateStaff(getDb(), ctx, staffId, reason);
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/staff`);
  return { error: null, message: 'Deactivated. They have been signed out everywhere.' };
}

export async function permissionsAction(slug: string, staffId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_staff');
  const r = await setStaffPermissions(getDb(), ctx, staffId, formData.getAll('permissions').map(String));
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/staff`);
  return { error: null, message: 'Permissions saved.' };
}

export async function branchesAction(slug: string, staffId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_staff');
  const r = await setStaffBranches(getDb(), ctx, staffId, formData.getAll('branchIds').map(String));
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/staff`);
  return { error: null, message: 'Branches saved.' };
}
