import { ActionForm, Field } from '@/components/form';
import { adminSignInAction } from './actions';

export default function AdminLoginPage() {
  return (
    <main className="mx-auto flex max-w-sm flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Platform admin</h1>
      <ActionForm action={adminSignInAction} submitLabel="Sign in">
        <Field label="Email" name="email" type="email" autoComplete="username" />
        <Field label="Password" name="password" type="password" autoComplete="current-password" />
      </ActionForm>
    </main>
  );
}
