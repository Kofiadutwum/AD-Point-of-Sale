'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import type { PromotionKind } from '@/db/schema';
import { parseCedis } from '@/lib/money';
import { saveCoupon, savePromotion, setPromotionActive } from '@/server/promotions';
import { createGiftCardProduct, giftCardBalance, saveLoyaltySettings } from '@/server/rewards';
import { lookupStockItem } from '@/server/stock';
import { pageCtx } from '../page-ctx';

const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();
const num = (fd: FormData, k: string) => (text(fd, k) ? Number(text(fd, k)) : null);
const cedis = (fd: FormData, k: string) => (text(fd, k) ? parseCedis(text(fd, k)) : null);
const done = (slug: string) => revalidatePath(`/${slug}/app/promotions`);

export async function savePromotionAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_promotions');
  const productIds: string[] = [];
  for (const code of text(fd, 'codes').split(/[\s,]+/).filter(Boolean)) {
    const item = await lookupStockItem(getDb(), ctx, code, 'manage_promotions');
    if (!item) return { error: `No item has the barcode or SKU ${code}.` };
    productIds.push(item.productId);
  }
  const pct = num(fd, 'percent');
  const r = await savePromotion(getDb(), ctx, {
    name: text(fd, 'name'), kind: text(fd, 'kind') as PromotionKind, productIds, categoryIds: fd.getAll('categoryIds').map(String).filter(Boolean),
    percentBp: pct === null ? null : Math.round(pct * 100), amountPesewas: cedis(fd, 'amount'), buyQty: num(fd, 'buy'), getQty: num(fd, 'get'),
    groupQty: num(fd, 'groupQty'), groupPricePesewas: cedis(fd, 'groupPrice'), minSubtotalPesewas: cedis(fd, 'minSubtotal') ?? 0,
    startsOn: text(fd, 'startsOn') || null, endsOn: text(fd, 'endsOn') || null, days: fd.getAll('days').map(Number), startTime: text(fd, 'startTime') || null, endTime: text(fd, 'endTime') || null,
    stackable: fd.get('stackable') === 'on', requiresCoupon: fd.get('requiresCoupon') === 'on',
  });
  if (!r.ok) return { error: 'Check the details: each kind needs its own numbers (percent, amount, or quantities).' };
  done(slug);
  return { error: null, message: 'Promotion saved. Tills pick it up within a minute.' };
}

export async function togglePromotionAction(slug: string, id: string, active: boolean): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_promotions');
  await setPromotionActive(getDb(), ctx, id, active);
  done(slug);
  return { error: null, message: active ? 'Started.' : 'Stopped.' };
}

export async function saveCouponAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_promotions');
  const r = await saveCoupon(getDb(), ctx, { code: text(fd, 'code'), promotionId: text(fd, 'promotionId'), maxUses: num(fd, 'maxUses'), perCustomerLimit: num(fd, 'perCustomer'), expiresOn: text(fd, 'expiresOn') || null });
  if (!r.ok) return { error: r.error === 'duplicate_code' ? 'That code exists.' : 'Codes are 3 to 30 letters, numbers, or dashes.' };
  done(slug);
  return { error: null, message: 'Coupon created.' };
}

export async function saveLoyaltyAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_promotions');
  const r = await saveLoyaltySettings(getDb(), ctx, {
    loyaltyEnabled: fd.get('enabled') === 'on', pesewasPerPoint: cedis(fd, 'perPoint') ?? 100, pointValuePesewas: cedis(fd, 'pointValue') ?? 1,
    minRedeemPoints: num(fd, 'minRedeem') ?? 100, pointsExpiryMonths: num(fd, 'expiry') ?? 0, giftCardExpiryMonths: num(fd, 'giftExpiry') ?? 0,
  });
  if (!r.ok) return { error: 'Check the numbers.' };
  done(slug);
  return { error: null, message: 'Saved.' };
}

export async function checkGiftCardAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'make_sale');
  const b = await giftCardBalance(getDb(), ctx, text(fd, 'code'));
  if (!b) return { error: 'No gift card has that code.' };
  return { error: null, message: `Balance GHS ${(b.balancePesewas / 100).toFixed(2)}${b.expiresOn ? `, expires ${b.expiresOn}` : ''}${b.status !== 'active' ? ' (void)' : ''}.` };
}

export async function giftCardProductAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_promotions');
  const amount = cedis(fd, 'amount');
  const r = await createGiftCardProduct(getDb(), ctx, amount ?? 0);
  if (!r.ok) return { error: 'Enter a value between GHS 1 and GHS 100,000 (and allow product changes).' };
  return { error: null, message: 'Gift card added. Sell it like any item; the receipt shows its code.' };
}
