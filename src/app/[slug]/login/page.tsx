import { ActionForm, Field } from '@/components/form';
import { signInAction } from './actions';

export default async function LoginPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <main className="mx-auto flex max-w-sm flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <ActionForm action={signInAction.bind(null, slug)} submitLabel="Sign in">
        <Field label="Email or phone" name="identifier" autoComplete="username" />
        <Field label="Password" name="password" type="password" autoComplete="current-password" />
      </ActionForm>
      <a href={`/${slug}/till`} className="text-sm text-blue-800 underline">Use a till PIN instead</a>
    </main>
  );
}
