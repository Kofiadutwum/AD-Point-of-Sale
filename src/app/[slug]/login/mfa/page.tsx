import { ActionForm, Field } from '@/components/form';
import { mfaAction } from './actions';

export default async function MfaPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <main className="mx-auto flex max-w-sm flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Two-step sign-in</h1>
      <ActionForm action={mfaAction.bind(null, slug)} submitLabel="Sign in">
        <Field label="Code from your authenticator app, or a recovery code" name="code" autoComplete="one-time-code" autoFocus />
      </ActionForm>
      <a href={`/${slug}/login`} className="text-sm text-blue-800 underline">Start again</a>
    </main>
  );
}
