import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { API_SCOPES, WEBHOOK_EVENTS } from '@/db/schema';
import { listApiKeys } from '@/server/api-keys';
import { listDomains } from '@/server/domains';
import { appUrl, shopPaystackStatus } from '@/server/shop-paystack';
import { listEndpoints } from '@/server/webhooks';
import { pageCtx } from '../page-ctx';
import {
  addDomainAction, addWebhookAction, createKeyAction, removeDomainAction, removeWebhookAction, revokeKeyAction, savePaystackAction, verifyDomainAction,
} from './actions';

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : 'never');

/** Phase 6: the shop's own Paystack account, API keys, outgoing webhooks, and its own domain. Owner only. */
export default async function IntegrationsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'manage_integrations');
  const db = getDb();
  const [paystack, keys, hooks, domains] = await Promise.all([shopPaystackStatus(db, ctx), listApiKeys(db, ctx), listEndpoints(db, ctx), listDomains(db, ctx)]);
  return (
    <main className="flex max-w-2xl flex-col gap-8">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Payments and integrations</h1>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Paystack (card and mobile money)</h2>
        <p className="text-sm text-gray-700">Use your shop&apos;s own Paystack account. Money goes straight to your Paystack balance and your bank; we never hold it. Paste the secret key from Paystack → Settings → API Keys.</p>
        {paystack.connected ? (
          <>
            <p className="text-sm">Connected: <span className="font-mono">{paystack.hint}</span></p>
            <p className="text-sm">In Paystack → Settings → API Keys, set the webhook URL to:<br /><span className="break-all font-mono">{paystack.webhookUrl}</span></p>
            <ActionForm action={savePaystackAction.bind(null, slug, true)} submitLabel="Disconnect Paystack"><span /></ActionForm>
          </>
        ) : (
          <ActionForm action={savePaystackAction.bind(null, slug, false)} submitLabel="Connect Paystack">
            <Field label="Secret key" name="key" type="password" autoComplete="off" placeholder="sk_live_…" />
          </ActionForm>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">API keys</h2>
        <p className="text-sm text-gray-700">Let another system read your data: <span className="font-mono">GET {appUrl()}/api/v1/products</span> (also stock, orders, and sales?from=YYYY-MM-DD&amp;to=YYYY-MM-DD) with the header <span className="font-mono">Authorization: Bearer &lt;key&gt;</span>.</p>
        <ul className="divide-y text-sm">{keys.map((k) => (
          <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>{k.name} <span className="font-mono text-gray-600">ads_{k.prefix}_…</span> · {k.scopes.join(', ')} · last used {day(k.lastUsedAt)}{k.revokedAt ? ' · revoked' : ''}</span>
            {!k.revokedAt && <ActionForm action={revokeKeyAction.bind(null, slug, k.id)} submitLabel="Revoke"><span /></ActionForm>}
          </li>
        ))}</ul>
        <ActionForm action={createKeyAction.bind(null, slug)} submitLabel="Create key">
          <Field label="Name (what uses it)" name="name" maxLength={60} placeholder="Accounting sync" />
          <fieldset className="flex flex-wrap gap-3 text-sm">{API_SCOPES.map((s) => <label key={s} className="flex items-center gap-1"><input type="checkbox" name="scopes" value={s} />{s}</label>)}</fieldset>
        </ActionForm>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Webhooks</h2>
        <p className="text-sm text-gray-700">We POST JSON to your address when something happens. Check the <span className="font-mono">x-webhook-signature</span> header: HMAC-SHA256 of &quot;timestamp.body&quot; with your signing secret.</p>
        <ul className="divide-y text-sm">{hooks.endpoints.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="break-all">{e.url} · {e.events.join(', ')}</span>
            <ActionForm action={removeWebhookAction.bind(null, slug, e.id)} submitLabel="Remove"><span /></ActionForm>
          </li>
        ))}</ul>
        <ActionForm action={addWebhookAction.bind(null, slug)} submitLabel="Add webhook">
          <Field label="Address (https://)" name="url" type="url" placeholder="https://example.com/hooks/pos" />
          <fieldset className="flex flex-wrap gap-3 text-sm">{WEBHOOK_EVENTS.map((ev) => <label key={ev} className="flex items-center gap-1"><input type="checkbox" name="events" value={ev} />{ev}</label>)}</fieldset>
        </ActionForm>
        {hooks.recent.length > 0 && (
          <details className="text-sm"><summary>Recent deliveries</summary>
            <ul>{hooks.recent.map((d) => <li key={d.id}>{d.createdAt.toISOString().slice(0, 16).replace('T', ' ')} · {d.event} · {d.status} ({d.attempts} tries){d.lastError ? ` · ${d.lastError}` : ''}</li>)}</ul>
          </details>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Your shop address</h2>
        {domains.subdomain && <p className="text-sm">Your shop also opens at <span className="font-mono">{domains.subdomain}</span>.</p>}
        <ul className="divide-y text-sm">{domains.domains.map((d) => (
          <li key={d.id} className="flex flex-col gap-1 py-2">
            <span className="font-semibold">{d.host} · {d.verified ? 'live' : 'waiting for DNS'}</span>
            {!d.verified && <span>Add a TXT record named <span className="font-mono">{d.txtName}</span> with the value <span className="break-all font-mono">{d.txtValue}</span>, and a CNAME from {d.host} to {domains.subdomain ?? new URL(appUrl()).hostname}.</span>}
            <div className="flex gap-2">
              {!d.verified && <ActionForm action={verifyDomainAction.bind(null, slug, d.id)} submitLabel="Check"><span /></ActionForm>}
              <ActionForm action={removeDomainAction.bind(null, slug, d.id)} submitLabel="Remove"><span /></ActionForm>
            </div>
          </li>
        ))}</ul>
        <ActionForm action={addDomainAction.bind(null, slug)} submitLabel="Add domain">
          <Field label="Your domain" name="host" placeholder="shop.example.com" />
        </ActionForm>
      </section>
    </main>
  );
}
