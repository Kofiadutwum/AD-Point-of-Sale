'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { confirmMfaEnrolment, disableMfa, type MfaError, regenerateRecoveryCodes, startMfaEnrolment } from '@/server/mfa';
import { pageCtx } from '../page-ctx';

const MESSAGES: Record<MfaError, string> = {
  password_session_required: 'Sign in with your password to change two-step sign-in.',
  already_enabled: 'Two-step sign-in is already on.',
  not_enabled: 'Two-step sign-in is off.',
  not_started: 'Start the set-up again.',
  wrong_code: 'Wrong code.',
};
const SAVE = 'Save these recovery codes now; each works once.';
const code = (formData: FormData) => String(formData.get('code') ?? '');

export async function startAction(slug: string, _prev: FormState, _formData: FormData): Promise<FormState> {
  const r = await startMfaEnrolment(getDb(), await pageCtx(slug, null));
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/security`);
  return { error: null };
}

export async function confirmAction(slug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const r = await confirmMfaEnrolment(getDb(), await pageCtx(slug, null), code(formData), new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  return { error: null, message: `Two-step sign-in is on. ${SAVE}`, copy: r.recoveryCodes.join('\n') };
}

export async function regenerateAction(slug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const r = await regenerateRecoveryCodes(getDb(), await pageCtx(slug, null), code(formData), new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  return { error: null, message: `New recovery codes. The old ones no longer work. ${SAVE}`, copy: r.recoveryCodes.join('\n') };
}

export async function disableAction(slug: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const r = await disableMfa(getDb(), await pageCtx(slug, null), code(formData), new Date());
  if (!r.ok) return { error: MESSAGES[r.error] };
  revalidatePath(`/${slug}/app/security`);
  return { error: null, message: 'Two-step sign-in is off.' };
}
