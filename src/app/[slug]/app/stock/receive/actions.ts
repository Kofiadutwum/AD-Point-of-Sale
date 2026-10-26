'use server';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { parseCedis } from '@/lib/money';
import { lookupStockItem, receiveStock, stockOnHand } from '@/server/stock';
import { pageCtx } from '../../page-ctx';

const MESSAGES: Record<string, string> = {
  invalid_input: 'Check the details.', unknown_branch: 'Choose a branch.', unknown_item: 'No item has that barcode or SKU.',
  not_purchasable: 'That unit cannot be bought. Use another unit.', not_stocked: 'Bundles and recipes hold no stock. Receive their parts.',
  invalid_quantity: 'Enter a valid quantity.', batch_required: 'Enter the batch number and expiry date.',
  expired_batch: 'That batch has expired. Expired stock cannot be received.', batch_expiry_mismatch: 'That batch number already has a different expiry date.',
  serials_mismatch: 'Enter one serial number per unit, one per line.', duplicate_serial: 'A serial number is already in stock.',
};

const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();

export async function receiveAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'receive_stock');
  const db = getDb();
  const item = await lookupStockItem(db, ctx, text(fd, 'code'));
  if (!item) return { error: MESSAGES.unknown_item };
  const cost = parseCedis(text(fd, 'cost') || '0');
  if (cost === null) return { error: 'Enter the total cost in GHS, for example 120.50.' };
  const branchId = text(fd, 'branchId');
  const r = await receiveStock(db, ctx, {
    branchId, kind: text(fd, 'kind') === 'opening_stock' ? 'opening_stock' : 'received', supplierName: text(fd, 'supplier') || undefined,
    lines: [{
      variantId: item.variantId, unitId: item.unitId, quantity: text(fd, 'quantity'), totalCostPesewas: cost,
      batchNumber: text(fd, 'batch') || undefined, expiryDate: text(fd, 'expiry') || undefined,
      serials: text(fd, 'serials') ? text(fd, 'serials').split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : undefined,
    }],
  }, new Date());
  if (!r.ok) return { error: MESSAGES[r.error] ?? 'Check the details.' };
  const onHand = await withTenant(db, ctx.tenantId, (tx) => stockOnHand(tx, branchId, item.variantId));
  return { error: null, message: `Received ${item.name} (${item.unitName}). On hand now: ${onHand}.` };
}
