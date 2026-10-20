import { ActionForm, Field } from '@/components/form';
import { activateAction } from './actions';

export default async function ActivatePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="mx-auto flex max-w-sm flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Set up your account</h1>
      <ActionForm action={activateAction.bind(null, token)} submitLabel="Save and continue">
        <Field label="Password (at least 10 characters)" name="password" type="password" autoComplete="new-password" minLength={10} />
        <Field label="Confirm password" name="confirm" type="password" autoComplete="new-password" />
        <Field label="Till PIN (4 to 6 digits, optional)" name="pin" inputMode="numeric" pattern="\d{4,6}" required={false} />
      </ActionForm>
    </main>
  );
}
