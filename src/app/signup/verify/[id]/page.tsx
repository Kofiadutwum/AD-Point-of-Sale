import type { Metadata } from 'next';
import { ActionForm, Field } from '@/components/form';
import { completeSignupAction } from '../../actions';

export const metadata: Metadata = { title: 'Confirm your sign-up', robots: { index: false } };

export default async function SignupVerifyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="mx-auto my-10 flex max-w-md flex-col gap-4 p-4">
      <h1 className="text-2xl font-semibold">Enter your codes</h1>
      <p className="text-sm text-gray-700">We sent a 6-digit code by SMS and another by email. They expire in 30 minutes.</p>
      <ActionForm action={completeSignupAction.bind(null, id)} submitLabel="Create my shop">
        <Field label="SMS code" name="smsCode" inputMode="numeric" autoComplete="one-time-code" maxLength={6} />
        <Field label="Email code" name="emailCode" inputMode="numeric" maxLength={6} />
        <Field label="Choose a password (at least 10 characters)" name="password" type="password" autoComplete="new-password" minLength={10} />
      </ActionForm>
    </main>
  );
}
