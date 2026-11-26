import QRCode from 'qrcode';
import { ActionForm, Check, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { getOnlineOrderSettings } from '@/server/online-orders';
import { getStorefront, storefrontStatsSummary } from '@/server/storefront';
import { pageCtx } from '../page-ctx';
import { publishAction, saveOnlineOrdersAction, saveStorefrontAction } from './actions';

/** Spec 4.12, 6.18: the shop section, publishing, the link and QR code for flyers, and visit counts. */
export default async function StorefrontAdminPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'manage_storefront');
  const [sf, stats, online] = await Promise.all([getStorefront(getDb(), ctx), storefrontStatsSummary(getDb(), ctx, new Date()), getOnlineOrderSettings(getDb(), ctx)]);
  const link = `${process.env.APP_URL ?? 'http://localhost:3000'}/${slug}`;
  const qr = await QRCode.toString(link, { type: 'svg', margin: 1 });
  const s = sf.settings;
  return (
    <main className="flex max-w-2xl flex-col gap-6">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Storefront</h1>
      {sf.takenDown && <p className="rounded border border-red-600 p-2 text-sm text-red-800">The platform took your storefront down. Check your email for the reason.</p>}
      <section className="flex flex-col gap-2">
        <p>{sf.published ? 'Live' : 'Hidden'} · {sf.shownProducts} products marked &quot;Show on storefront&quot; (set this on each product).</p>
        <ActionForm action={publishAction.bind(null, slug, !sf.published)} submitLabel={sf.published ? 'Hide storefront' : 'Publish storefront'}><span /></ActionForm>
        {sf.published && (
          <div className="flex items-center gap-4">
            <div className="w-32" dangerouslySetInnerHTML={{ __html: qr }} />
            <p className="break-all text-sm"><a className="text-blue-800 underline" href={`/${slug}`}>{link}</a><br />Print the QR code on flyers; share the link on WhatsApp.</p>
          </div>
        )}
        <p className="text-sm text-gray-700">Last 30 days: {stats.pageViews} page views, {stats.productViews} product views, {stats.whatsappClicks} WhatsApp clicks, {stats.callClicks} calls.</p>
      </section>
      <ActionForm action={saveStorefrontAction.bind(null, slug)} submitLabel="Save storefront">
        <label className="flex flex-col gap-1 text-sm">About the shop (up to 500 characters)
          <textarea name="about" defaultValue={s.about} maxLength={500} rows={3} className="rounded border border-gray-400 px-3 py-2" />
        </label>
        <Field label="WhatsApp number for orders" name="whatsapp" type="tel" defaultValue={s.whatsapp} required={false} />
        <Field label="Opening hours" name="hours" defaultValue={s.hours} required={false} maxLength={200} placeholder="Mon-Sat 8am-8pm" />
        <Field label="Theme colour" name="themeColor" type="color" defaultValue={s.themeColor} />
        <Field label="Facebook page (https://...)" name="facebook" type="url" defaultValue={s.facebook} required={false} />
        <Field label="Instagram page (https://...)" name="instagram" type="url" defaultValue={s.instagram} required={false} />
        <Check name="showPrices" label="Show prices (otherwise &quot;Call for price&quot;)" defaultChecked={s.showPrices} />
        <Check name="showStock" label="Show In stock / Out of stock" defaultChecked={s.showStock} />
        <Field label="Announcement (e.g. New stock arrived)" name="announcement" defaultValue={s.announcement} required={false} maxLength={140} />
        <Field label="Show the announcement until" name="announcementUntil" type="date" defaultValue={s.announcementUntil} required={false} />
      </ActionForm>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Online orders</h2>
        <p className="text-sm text-gray-700">Visitors order from your storefront, prove their phone by SMS code, and pay with Paystack (connect it under Payments and integrations) or by transfer with a screenshot. Items are held until the order is paid or lapses.</p>
        <ActionForm action={saveOnlineOrdersAction.bind(null, slug)} submitLabel="Save online orders">
          <Check name="enabled" label="Take online orders" defaultChecked={online.enabled} />
          <Field label="Unpaid orders lapse after (minutes)" name="expiry" type="number" min={10} max={10080} defaultValue={online.expiryMinutes} />
          <Field label="Delivery fee, paid on delivery (GHS)" name="fee" inputMode="decimal" defaultValue={(online.deliveryFeePesewas / 100).toFixed(2)} />
          <label className="flex flex-col gap-1 text-sm">Transfer details for customers (bank or MoMo; leave empty to take Paystack only)
            <textarea name="transfer" defaultValue={online.transferInstructions ?? ''} maxLength={500} rows={3} className="rounded border border-gray-400 px-3 py-2" />
          </label>
        </ActionForm>
      </section>
    </main>
  );
}
