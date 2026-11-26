import { ActionForm, Check, Field } from '@/components/form';
import { getDb } from '@/db/client';
import { formatCedis } from '@/lib/money';
import { listCategories } from '@/server/products';
import { listCoupons, listPromotions } from '@/server/promotions';
import { getLoyaltySettings, giftCardLiability } from '@/server/rewards';
import { pageCtx } from '../page-ctx';
import { checkGiftCardAction, giftCardProductAction, saveCouponAction, saveLoyaltyAction, savePromotionAction, togglePromotionAction } from './actions';

const select = 'rounded border border-gray-400 px-3 py-2';
const KINDS = { percent_off: 'Percent off items', amount_off: 'Amount off each item', buy_x_get_y: 'Buy X get Y', multi_buy: 'N for a price', cart_percent: 'Percent off the cart', cart_amount: 'Amount off the cart' } as const;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Spec 4.20: automatic promotions, coupon codes, loyalty points, and gift cards. */
export default async function PromotionsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await pageCtx(slug, 'manage_promotions');
  const db = getDb();
  const [promos, coupons, loyalty, cats, held] = await Promise.all([
    listPromotions(db, ctx), listCoupons(db, ctx), getLoyaltySettings(db, ctx), listCategories(db, ctx).catch(() => []), giftCardLiability(db, ctx).catch(() => null),
  ]);
  return (
    <main className="flex max-w-3xl flex-col gap-8">
      <a href={`/${slug}/app`} className="text-sm text-blue-800 underline">← Home</a>
      <h1 className="text-2xl font-semibold">Promotions and loyalty</h1>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Promotions</h2>
        <p className="text-sm text-gray-700">Each item gets its single best promotion unless a promotion is marked as adding on. Manual discounts still follow staff limits.</p>
        <ul className="text-sm">{promos.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2">
            <span className={p.active ? '' : 'text-gray-500 line-through'}>{p.name}</span>
            <span className="text-gray-600">{KINDS[p.kind]}{p.requiresCoupon ? ' · coupon only' : ''}{p.startsOn || p.endsOn ? ` · ${p.startsOn ?? '…'} to ${p.endsOn ?? '…'}` : ''}{p.startTime ? ` · ${p.startTime}-${p.endTime ?? ''}` : ''}</span>
            <ActionForm action={togglePromotionAction.bind(null, slug, p.id, !p.active)} submitLabel={p.active ? 'Stop' : 'Start'}><span /></ActionForm>
          </li>
        ))}</ul>
        <details><summary className="cursor-pointer text-sm text-blue-800 underline">New promotion</summary>
          <ActionForm action={savePromotionAction.bind(null, slug)} submitLabel="Save promotion">
            <Field label="Name (shown on the customer display)" name="name" maxLength={80} />
            <label className="flex flex-col gap-1 text-sm">Kind<select name="kind" className={select}>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <div className="flex flex-wrap gap-2">
              <Field label="Percent off" name="percent" inputMode="decimal" required={false} />
              <Field label="Amount off (GHS)" name="amount" inputMode="decimal" required={false} />
              <Field label="Buy" name="buy" type="number" min={1} required={false} />
              <Field label="Get" name="get" type="number" min={1} required={false} />
              <Field label="N items" name="groupQty" type="number" min={2} required={false} />
              <Field label="For (GHS)" name="groupPrice" inputMode="decimal" required={false} />
              <Field label="Cart above (GHS)" name="minSubtotal" inputMode="decimal" required={false} />
            </div>
            <Field label="Only these items (barcodes or SKUs; blank = all)" name="codes" required={false} />
            {cats.length > 0 && <label className="flex flex-col gap-1 text-sm">Or these categories<select name="categoryIds" multiple className={select}>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
            <div className="flex flex-wrap gap-2"><Field label="From" name="startsOn" type="date" required={false} /><Field label="To" name="endsOn" type="date" required={false} /><Field label="Happy hour from" name="startTime" type="time" required={false} /><Field label="to" name="endTime" type="time" required={false} /></div>
            <fieldset className="flex flex-wrap gap-2 text-sm"><legend>Days (none = every day)</legend>{DAYS.map((d, i) => <label key={d} className="flex items-center gap-1"><input type="checkbox" name="days" value={i} />{d}</label>)}</fieldset>
            <Check name="stackable" label="Adds on to other promotions" />
            <Check name="requiresCoupon" label="Only with a coupon code" />
          </ActionForm>
        </details>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Coupons</h2>
        <ul className="text-sm">{coupons.map(({ c, promotionName }) => <li key={c.id}><span className="font-mono">{c.code}</span> · {promotionName} · used {c.usedCount}{c.maxUses ? ` of ${c.maxUses}` : ''}{c.expiresOn ? ` · until ${c.expiresOn}` : ''}</li>)}</ul>
        {promos.length > 0 && (
          <ActionForm action={saveCouponAction.bind(null, slug)} submitLabel="Create coupon">
            <div className="flex flex-wrap gap-2">
              <Field label="Code" name="code" maxLength={30} />
              <label className="flex flex-col gap-1 text-sm">Promotion<select name="promotionId" className={select}>{promos.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <Field label="Uses (blank = no limit)" name="maxUses" type="number" min={1} required={false} />
              <Field label="Per customer" name="perCustomer" type="number" min={1} required={false} />
              <Field label="Expires" name="expiresOn" type="date" required={false} />
            </div>
          </ActionForm>
        )}
      </section>

      <section className="flex max-w-md flex-col gap-2">
        <h2 className="text-lg font-semibold">Loyalty points</h2>
        <ActionForm action={saveLoyaltyAction.bind(null, slug)} submitLabel="Save loyalty">
          <Check name="enabled" label="Customers earn points" defaultChecked={loyalty.loyaltyEnabled} />
          <Field label="Spend for one point (GHS)" name="perPoint" inputMode="decimal" defaultValue={(loyalty.pesewasPerPoint / 100).toFixed(2)} />
          <Field label="One point is worth (GHS)" name="pointValue" inputMode="decimal" defaultValue={(loyalty.pointValuePesewas / 100).toFixed(2)} />
          <Field label="Fewest points to spend" name="minRedeem" type="number" min={1} defaultValue={loyalty.minRedeemPoints} />
          <Field label="Points expire after (months, 0 = never)" name="expiry" type="number" min={0} max={120} defaultValue={loyalty.pointsExpiryMonths} />
          <Field label="Gift cards expire after (months, 0 = never)" name="giftExpiry" type="number" min={0} max={120} defaultValue={loyalty.giftCardExpiryMonths} />
        </ActionForm>
      </section>

      <section className="flex max-w-md flex-col gap-2">
        <h2 className="text-lg font-semibold">Gift cards</h2>
        {held && <p className="text-sm text-gray-700">Unspent: {formatCedis(held.balancePesewas)} on {held.cards} cards (money held for customers, not sales).</p>}
        <ActionForm action={giftCardProductAction.bind(null, slug)} submitLabel="Add a gift card to sell">
          <Field label="Card value (GHS)" name="amount" inputMode="decimal" />
        </ActionForm>
        <ActionForm action={checkGiftCardAction.bind(null, slug)} submitLabel="Check balance">
          <Field label="Gift card code" name="code" maxLength={30} />
        </ActionForm>
      </section>
    </main>
  );
}
