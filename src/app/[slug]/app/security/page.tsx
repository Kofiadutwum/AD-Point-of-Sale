import { redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { getMfaStatus } from '@/server/mfa';
import { pageCtx } from '../page-ctx';
import { confirmAction, disableAction, regenerateAction, startAction } from './actions';

export default async function SecurityPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, null);
  if (ctx.sessionKind !== 'password') redirect(`/${slug}/app`); // a till PIN never manages two-step sign-in
  const status = await getMfaStatus(getDb(), ctx);
  const qr = status.pending ? await QRCode.toString(status.pending.otpauthUri, { type: 'svg', margin: 1 }) : null;
  const codeField = <Field label="Code from your authenticator app" name="code" inputMode="numeric" autoComplete="one-time-code" />;
  return (
    <main className="flex flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Two-step sign-in</h1>
      {status.enabled ? (
        <>
          <p className="text-sm">On. Signing in with your password also needs a code from your authenticator app. {status.recoveryCodesLeft} recovery codes left.</p>
          <section className="flex flex-col gap-2">
            <h2 className="font-semibold">New recovery codes</h2>
            <ActionForm action={regenerateAction.bind(null, slug)} submitLabel="Make new recovery codes">{codeField}</ActionForm>
          </section>
          <section className="flex flex-col gap-2">
            <h2 className="font-semibold">Turn off</h2>
            <ActionForm action={disableAction.bind(null, slug)} submitLabel="Turn off two-step sign-in">
              <Field label="Code from your authenticator app, or a recovery code" name="code" />
            </ActionForm>
          </section>
        </>
      ) : status.pending ? (
        <section className="flex flex-col gap-3">
          <p className="text-sm">Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator, or similar), then enter the 6-digit code it shows.</p>
          <div className="w-48" dangerouslySetInnerHTML={{ __html: qr! }} />
          <p className="text-sm">Or enter this key: <code className="break-all">{status.pending.secret.match(/.{1,4}/g)!.join(' ')}</code></p>
          <ActionForm action={confirmAction.bind(null, slug)} submitLabel="Turn on">{codeField}</ActionForm>
        </section>
      ) : (
        <section className="flex flex-col gap-3">
          <p className="text-sm">Off. Turn it on so a stolen password alone cannot open your shop.</p>
          <ActionForm action={startAction.bind(null, slug)} submitLabel="Set up two-step sign-in"><span /></ActionForm>
        </section>
      )}
    </main>
  );
}
