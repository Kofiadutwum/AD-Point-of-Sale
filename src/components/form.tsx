'use client';
import { useActionState } from 'react';

export type FormState = { error: string | null; message?: string | null; copy?: string | null };
export type FormAction = (prev: FormState, formData: FormData) => Promise<FormState>;

/** A server-action form that shows the action's error or message under its fields. */
export function ActionForm({ action, submitLabel, children }: { action: FormAction; submitLabel: string; children: React.ReactNode }) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  return (
    <form action={formAction} className="flex flex-col gap-3">
      {children}
      {state.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}
      {state.message && <p role="status" className="break-all text-sm text-green-800">{state.message}</p>}
      {state.copy && <CopyBox text={state.copy} />}
      <button type="submit" disabled={pending} className="rounded bg-blue-800 px-4 py-2 text-white disabled:opacity-50">
        {pending ? 'Please wait…' : submitLabel}
      </button>
    </form>
  );
}

export function Field({ label, name, type = 'text', required = true, ...rest }: { label: string; name: string; type?: string; required?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input name={name} type={type} required={required} className="rounded border border-gray-400 px-3 py-2" {...rest} />
    </label>
  );
}

export function Check({ label, name, ...rest }: { label: string; name: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name={name} {...rest} />
      {label}
    </label>
  );
}

/** A link with a Copy button, for activation and invite links sent by WhatsApp. */
export function CopyBox({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded border border-gray-300 bg-gray-50 p-2">
      <code className="flex-1 break-all text-xs">{text}</code>
      <button type="button" onClick={() => navigator.clipboard.writeText(text)} className="rounded border px-2 py-1 text-sm">Copy link</button>
    </div>
  );
}
