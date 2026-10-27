import { ActionForm, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { type Channel, listChannels } from '@/server/channels';
import { listPriceLists } from '@/server/price-lists';
import { pageCtx } from '../../page-ctx';
import { saveChannelAction } from './actions';

const KINDS = { delivery_app: 'Delivery app', phone: 'Phone', whatsapp: 'WhatsApp' } as const;

/** Spec 6.57: delivery apps, phone, and WhatsApp, each with its own prices and commission. */
export default async function ChannelsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'manage_channels');
  const [channels, lists] = await Promise.all([listChannels(getDb(), ctx), ctx.permissions.includes('manage_products') ? listPriceLists(getDb(), ctx) : []]);
  return (
    <main className="flex max-w-2xl flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Sales channels</h1>
      <p className="text-sm text-gray-700">Walk-in customers need no channel. Add Bolt Food, Chowdeck, phone, or WhatsApp orders here. Type each app&rsquo;s commission from your contract.</p>
      {channels.map((c) => (
        <section key={c.id} className="rounded border p-3">
          <h2 className="font-semibold">{c.name} · {KINDS[c.kind]}{c.active ? '' : ' (not in use)'}</h2>
          <ChannelForm slug={slug} channel={c} lists={lists} />
        </section>
      ))}
      <section className="rounded border p-3">
        <h2 className="font-semibold">Add a channel</h2>
        <ChannelForm slug={slug} channel={null} lists={lists} />
      </section>
    </main>
  );
}

function ChannelForm({ slug, channel: c, lists }: { slug: string; channel: Channel | null; lists: Array<{ id: string; name: string }> }) {
  return (
    <ActionForm action={saveChannelAction.bind(null, slug, c?.id ?? null)} submitLabel={c ? 'Save' : 'Add channel'}>
      <Field label="Name" name="name" maxLength={40} defaultValue={c?.name} />
      <label className="flex flex-col gap-1 text-sm">Kind
        <select name="kind" defaultValue={c?.kind ?? 'delivery_app'} className="rounded border border-gray-400 px-3 py-2">
          {Object.entries(KINDS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">Price list
        <select name="priceListId" defaultValue={c?.priceListId ?? ''} className="rounded border border-gray-400 px-3 py-2">
          <option value="">Same prices as walk-in</option>
          {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </label>
      <Field label="Commission (%)" name="commission" inputMode="decimal" required={false} defaultValue={c ? String(c.commissionBp / 100) : '0'} />
      <label className="flex flex-col gap-1 text-sm">Who collects the money
        <select name="collectedBy" defaultValue={c?.collectedBy ?? 'shop'} className="rounded border border-gray-400 px-3 py-2">
          <option value="shop">The shop (cash, MoMo, card)</option>
          <option value="app">The delivery app pays us later</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={c?.active ?? true} /> In use</label>
    </ActionForm>
  );
}
