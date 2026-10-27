import type { DeviceCache, SaleRequest } from '@/lib/device-contract';
import type { DeviceMeta } from './store';

// Offline checks and the sale request the till sends (spec 4.9, 6.8, 6.10).

export const OFFLINE_LIMIT_MS = 72 * 3_600_000;
const CONNECT = 'Connect to the internet to continue';

export type TenderInput = { method: 'cash' | 'momo_manual' | 'card_terminal' | 'bank_transfer'; amountPesewas: number; reference: string };

/** Why this till may not sell offline right now, or null. */
export function offlineBlock(cache: DeviceCache | null, meta: DeviceMeta, now: number): string | null {
  if (!cache || !cache.shop.offlineEnabled || meta.lastSyncAt === null || now - meta.lastSyncAt > OFFLINE_LIMIT_MS) return CONNECT;
  if (!cache.shop.canSell) return 'Your subscription has ended. Renew to sell again.';
  return null;
}

/** Spec 6.8: manual payments need a reference, and only cash can give change. */
export function checkTenders(tenders: TenderInput[], totalPesewas: number): { ok: true; changeDuePesewas: number } | { ok: false; error: string } {
  if (tenders.length === 0) return { ok: false, error: 'Add a payment.' };
  if (tenders.some((t) => !Number.isSafeInteger(t.amountPesewas) || t.amountPesewas <= 0)) return { ok: false, error: 'Enter each amount in cedis.' };
  if (tenders.some((t) => t.method !== 'cash' && !t.reference.trim())) return { ok: false, error: 'Enter the reference for MoMo, card, or bank payments.' };
  const nonCash = tenders.filter((t) => t.method !== 'cash').reduce((s, t) => s + t.amountPesewas, 0);
  if (nonCash > totalPesewas) return { ok: false, error: 'Only cash can give change. Reduce the MoMo, card, or bank amount.' };
  const paid = tenders.reduce((s, t) => s + t.amountPesewas, 0);
  if (paid < totalPesewas) return { ok: false, error: 'Not enough paid yet.' };
  return { ok: true, changeDuePesewas: paid - totalPesewas };
}

/** Spec 6.0: branch-register-counter, e.g. ACC1-T2-000123. */
export function formatReceiptNumber(branchCode: string, registerCode: string, counter: number): string {
  return `${branchCode}-${registerCode}-${String(counter).padStart(6, '0')}`;
}

export function buildSaleRequest(i: {
  saleId: string; receiptNumber: string; cashierId: string;
  lines: Array<{ variantId: string; unitId: string; quantity: string; unitPricePesewas: number }>;
  tenders: TenderInput[]; tenderIds: string[]; now: Date; fromOfflineOutbox: boolean; food?: SaleRequest['food'];
}): SaleRequest {
  return {
    saleId: i.saleId, receiptNumber: i.receiptNumber, cashierId: i.cashierId, deviceCreatedAt: i.now.toISOString(), fromOfflineOutbox: i.fromOfflineOutbox,
    ...(i.food ? { food: i.food } : {}),
    lines: i.lines.map((l) => ({ variantId: l.variantId, unitId: l.unitId, quantity: l.quantity, unitPricePesewas: l.unitPricePesewas, discountPesewas: 0 })),
    tenders: i.tenders.map((t, k) => ({
      id: i.tenderIds[k], method: t.method, amountPesewas: t.amountPesewas, ...(t.method === 'cash' ? {} : { reference: t.reference.trim() }),
    })),
  };
}
