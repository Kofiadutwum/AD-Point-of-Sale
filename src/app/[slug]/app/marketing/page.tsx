import { ActionForm } from '@/components/form';
import { getDb } from '@/db/client';
import type { CampaignSegment } from '@/db/schema';
import { listCampaigns, previewCampaign, SEGMENTS } from '@/server/marketing';
import { smsUsage } from '@/server/notifications';
import { pageCtx } from '../page-ctx';
import { sendCampaignAction } from './actions';

const input = 'rounded border border-gray-400 px-3 py-2';

/** Spec 4.25, 6.42: write a promotional SMS, see the cost, then confirm. Only opted-in customers receive it. */
export default async function MarketingPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ segment?: string; message?: string }> }) {
  const { slug } = await params;
  const q = await searchParams;
  const ctx = await pageCtx(slug, 'marketing');
  const now = new Date();
  const segment = (Object.hasOwn(SEGMENTS, q.segment ?? '') ? q.segment : 'all') as CampaignSegment;
  const [usage, campaigns, check] = await Promise.all([
    smsUsage(getDb(), ctx, now), listCampaigns(getDb(), ctx), q.message ? previewCampaign(getDb(), ctx, { segment, message: q.message }, now) : null,
  ]);
  return (
    <main className="flex max-w-2xl flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Promotional SMS</h1>
      <p className="text-sm text-gray-700">SMS used this month: {usage.usedParts} of {usage.limitParts}. Only customers who agreed get these, never between 9 pm and 7 am. Each message ends with a link to stop them.</p>
      <form method="get" className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">Who
          <select name="segment" defaultValue={segment} className={input}>{Object.entries(SEGMENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </label>
        <label className="flex flex-col gap-1 text-sm">Message
          <textarea name="message" defaultValue={q.message ?? ''} maxLength={300} required rows={4} className={input} />
        </label>
        <button type="submit" className="self-start rounded border border-blue-800 px-4 py-2 text-blue-800">Check the cost</button>
      </form>
      {check && !check.ok && <p className="text-red-700">Write a message of up to 300 characters.</p>}
      {check?.ok && (
        <section className="flex flex-col gap-2 rounded border border-gray-300 p-3">
          <p className="whitespace-pre-wrap text-sm">{check.preview.text}</p>
          <p>{check.preview.recipients} customers × {check.preview.partsEach} SMS = <strong>{check.preview.totalParts} SMS</strong> ({check.preview.remainingParts} left this month)</p>
          {check.preview.recipients > 0 && check.preview.totalParts <= check.preview.remainingParts && (
            <ActionForm action={sendCampaignAction.bind(null, slug)} submitLabel={`Send to ${check.preview.recipients} customers`}>
              <input type="hidden" name="segment" value={segment} />
              <input type="hidden" name="message" value={q.message} />
              <input type="hidden" name="confirmedParts" value={check.preview.totalParts} />
            </ActionForm>
          )}
        </section>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Recent messages</h2>
        {campaigns.length === 0 ? <p className="text-sm text-gray-700">None yet.</p> : (
          <ul className="text-sm">{campaigns.map((c) => (
            <li key={c.id}>{c.sendAfter.toISOString().slice(0, 16).replace('T', ' ')} · {SEGMENTS[c.segment]} · {c.sent} of {c.recipients} sent · {c.message}</li>
          ))}</ul>
        )}
      </section>
    </main>
  );
}
