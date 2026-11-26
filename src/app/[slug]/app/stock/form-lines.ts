import 'server-only';
import { getDb } from '@/db/client';
import { parseCedis } from '@/lib/money';
import type { Permission } from '@/lib/permissions';
import type { Ctx } from '@/server/context';
import { lookupStockItem } from '@/server/stock';

export const ROWS = [0, 1, 2, 3, 4, 5];
const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();

export type FormLine = { variantId: string; unitId: string; quantity: string; batchNumber?: string; costPesewas: number };

/** Rows typed as barcode or SKU (code_k), quantity (qty_k), batch (batch_k), and cost in cedis (cost_k). */
export async function linesFromForm(ctx: Ctx, fd: FormData, permission: Permission): Promise<{ lines: FormLine[] } | { error: string }> {
  const lines: FormLine[] = [];
  for (const k of ROWS) {
    const code = text(fd, `code_${k}`);
    if (!code) continue;
    const item = await lookupStockItem(getDb(), ctx, code, permission);
    if (!item) return { error: `No item has the barcode or SKU ${code}.` };
    const cost = text(fd, `cost_${k}`) ? parseCedis(text(fd, `cost_${k}`)) : 0;
    if (cost === null) return { error: 'Enter costs in cedis.' };
    lines.push({ variantId: item.variantId, unitId: item.unitId, quantity: text(fd, `qty_${k}`) || '1', batchNumber: text(fd, `batch_${k}`) || undefined, costPesewas: cost });
  }
  return lines.length ? { lines } : { error: 'Scan or type at least one item.' };
}

export const LINE_ERRORS: Record<string, string> = {
  unknown_item: 'An item was not found.', not_stocked: 'Combos and recipes hold no stock.', invalid_quantity: 'Check the quantities (whole numbers unless the item is sold in parts).',
  serial_tracked: 'Items with serial numbers cannot be moved here yet.', batch_required: 'Batch items need the batch number.', not_enough_stock: 'Not enough stock for an item.',
  unknown_batch: 'That batch is not at this branch.', invalid_input: 'Check the details.', not_found: 'Not found.', approval_required: 'This needs a manager: choose who approves and enter their PIN.',
  wrong_pin: 'Wrong PIN.', not_authorised: 'That person cannot approve.', self_approval: 'Another person must approve.', pin_locked: 'Too many wrong PINs. Try again later.',
};
