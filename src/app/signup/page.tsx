import type { Metadata } from 'next';
import { ActionForm, Field } from '@/components/form';
import { startSignupAction } from './actions';

export const metadata: Metadata = { title: 'Start a free trial' };

/** Spec 4.27: a 14-day free trial, no card needed; the phone and email are checked with codes. */
export default function SignupPage() {
  return (
    <main className="mx-auto my-10 flex max-w-md flex-col gap-4 p-4">
      <h1 className="text-2xl font-semibold">Start a free 14-day trial</h1>
      <p className="text-sm text-gray-700">No card needed. We send one code to your phone and one to your email.</p>
      <ActionForm action={startSignupAction} submitLabel="Send codes">
        <Field label="Shop name" name="shopName" maxLength={100} />
        <Field label="Web address (letters, numbers, dashes)" name="slug" maxLength={40} pattern="[a-zA-Z0-9-]+" />
        <label className="flex flex-col gap-1 text-sm">Type of shop
          <select name="shopType" className="rounded border border-gray-400 px-3 py-2" defaultValue="retail">
            <option value="retail">Shop or supermarket</option><option value="pharmacy">Pharmacy or chemical seller</option><option value="food">Chop bar, grill, or fast food</option>
          </select>
        </label>
        <Field label="Your name" name="ownerName" maxLength={100} />
        <Field label="Email" name="email" type="email" autoComplete="email" />
        <Field label="Phone" name="phone" type="tel" autoComplete="tel" />
      </ActionForm>
    </main>
  );
}
