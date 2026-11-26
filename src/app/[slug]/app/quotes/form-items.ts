import 'server-only';
import { getDb } from '@/db/client';
import { normaliseGhanaPhone } from '@/lib/contact';
import { parseCedis } from '@/lib/money';
import type { Ctx } from '@/server/context';
import { listCustomers } from '@/server/customers';
import { lookupStockItem } from '@/server/stock';

const text = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();

/** The customer whose phone was typed, null when none was typed, or an error message. */
export async function customerFromForm(ctx: Ctx, fd: FormData): Promise<{ id: string | null } | { error: string }> {
  const typed = text(fd, 'phone');
  if (!typed) return { id: null };
  const phone = normaliseGhanaPhone(typed);
  if (!phone) return { error: 'Enter a Ghana phone number for the customer.' };
  const found = (await listCustomers(getDb(), ctx, { query: typed, limit: 5 })).find((c) => c.phone === phone);
  return found ? { id: found.id } : { error: 'No customer has that phone. Add them on the Customers page first.' };
}

/** Item rows typed by barcode or SKU, with quantities and discounts in cedis. */
export async function itemsFromForm(ctx: Ctx, fd: FormData): Promise<{ lines: Array<{ variantId: string; unitId: string; quantity: string; discountPesewas: number }> } | { error: string }> {
  const lines = [];
  for (const k of [0, 1, 2, 3, 4, 5, 6, 7]) {
    if (!text(fd, `code_${k}`)) continue;
    const item = await lookupStockItem(getDb(), ctx, text(fd, `code_${k}`), 'make_sale');
    if (!item) return { error: `No item has the barcode or SKU ${text(fd, `code_${k}`)}.` };
    const discount = text(fd, `disc_${k}`) ? parseCedis(text(fd, `disc_${k}`)) : 0;
    if (discount === null) return { error: 'Enter discounts in cedis.' };
    lines.push({ variantId: item.variantId, unitId: item.unitId, quantity: text(fd, `qty_${k}`) || '1', discountPesewas: discount });
  }
  return lines.length ? { lines } : { error: 'Scan or type at least one item.' };
}
