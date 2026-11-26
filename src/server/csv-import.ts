import 'server-only';
import { inArray } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { customers } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { normaliseGhanaPhone } from '@/lib/contact';
import { parseCsv } from '@/lib/csv-parse';
import { parseQuantity } from '@/lib/decimal';
import { parseCedis } from '@/lib/money';
import { writeAudit } from './audit';
import { assertPermission, type Ctx } from './context';
import { createProductTx, type Fail, fail } from './products';
import { lookupStockItem, type ReceiveLine, receiveStock } from './stock';

export type ImportKind = 'products' | 'customers' | 'opening_stock';
/** The published templates: these headers, in this order (spec 6.45). */
export const TEMPLATES: Record<ImportKind, readonly string[]> = {
  products: ['name', 'sku', 'barcode', 'price', 'cost', 'unit', 'allows_fractions', 'tracking', 'generic_name', 'prescription_only'],
  customers: ['name', 'phone'],
  opening_stock: ['code', 'quantity', 'total_cost', 'batch_number', 'expiry_date'],
};
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10_000;
export type RowError = { row: number; message: string }; // row = line in the file, the header being line 1
export type ImportCheck = { ok: true; rows: number; errors: RowError[]; preview: string[][] };
export type ImportFail = Fail<'invalid_input' | 'too_large' | 'wrong_headers' | 'has_errors' | 'nothing_to_import'>;

const MESSAGES: Record<string, string> = {
  duplicate_sku: 'that SKU is already used', duplicate_barcode: 'that barcode is already used', limit_reached: 'your plan has no room for more products',
  invalid_input: 'check the values', unknown_item: 'no item has that barcode or SKU', batch_required: 'batch number and expiry date are needed',
  expired_batch: 'that batch has already expired', invalid_quantity: 'check the quantity', not_stocked: 'that item holds no stock of its own',
  not_purchasable: 'that unit cannot be bought', batch_expiry_mismatch: 'that batch number has a different expiry date', looks_like_scale_label: 'that barcode looks like a scale label',
};
const yes = (v: string) => ['yes', 'y', 'true', '1'].includes(v.trim().toLowerCase());
const yesNo = (v: string) => v.trim() === '' || ['yes', 'y', 'true', '1', 'no', 'n', 'false', '0'].includes(v.trim().toLowerCase());

class Rollback extends Error {
  constructor(readonly errors: RowError[], readonly done: number) { super('rollback'); }
}

/** The file's rows under its headers, or why it cannot be read. */
function readFile(kind: ImportKind, text: string): { rows: string[][] } | ImportFail {
  if (typeof text !== 'string' || !TEMPLATES[kind]) return fail('invalid_input');
  if (new TextEncoder().encode(text).length > MAX_BYTES) return fail('too_large');
  const all = parseCsv(text);
  if (!all) return fail('invalid_input');
  const [header, ...rows] = all;
  const want = TEMPLATES[kind];
  if (!header || header.length < want.length || want.some((h, i) => header[i]?.trim().toLowerCase() !== h)) return fail('wrong_headers', want.join(','));
  if (rows.length > MAX_ROWS) return fail('too_large');
  if (rows.length === 0) return fail('nothing_to_import');
  return { rows: rows.map((r) => want.map((_, i) => (r[i] ?? '').trim())) };
}

/** Spec 6.45: checks every row (by really importing inside a transaction that is then undone) and returns errors with line numbers and a preview. */
export async function checkImport(db: Db, ctx: Ctx, input: { kind: ImportKind; text: string }): Promise<ImportCheck | ImportFail> {
  assertPermission(ctx, 'import_data');
  const file = readFile(input.kind, input.text);
  if ('ok' in file) return file;
  const errors = input.kind === 'opening_stock' ? (await stockLines(db, ctx, file.rows)).errors : await dryRun(db, ctx, input.kind, file.rows);
  return { ok: true, rows: file.rows.length, errors, preview: file.rows.slice(0, 20) };
}

/** Spec 6.45: imports all rows in one transaction; failing rows stop it unless the user chose to skip them. */
export async function runImport(db: Db, ctx: Ctx, input: { kind: ImportKind; text: string; branchId?: string; skipFailing: boolean }, now: Date): Promise<
  { ok: true; imported: number; skipped: number } | ImportFail
> {
  assertPermission(ctx, 'import_data');
  const file = readFile(input.kind, input.text);
  if ('ok' in file) return file;
  if (input.kind === 'opening_stock') {
    const { lines, errors } = await stockLines(db, ctx, file.rows);
    if (errors.length && !input.skipFailing) return fail('has_errors');
    if (!lines.length) return fail('nothing_to_import');
    const r = await receiveStock(db, ctx, { branchId: input.branchId ?? '', kind: 'opening_stock', note: 'CSV import', lines }, now);
    if (!r.ok) return fail('has_errors', `${MESSAGES[r.error] ?? r.error}${r.detail ? ` (${r.detail})` : ''}`);
    await withTenant(db, ctx.tenantId, (tx) => writeAudit(tx, {
      tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'import', changes: { kind: input.kind, rows: lines.length, skipped: errors.length },
    }));
    return { ok: true, imported: lines.length, skipped: errors.length };
  }
  try {
    return await withTenant(db, ctx.tenantId, async (tx) => {
      const { errors, done } = await importRows(tx, ctx, input.kind as 'products' | 'customers', file.rows);
      if ((errors.length && !input.skipFailing) || !done) throw new Rollback(errors, done);
      await writeAudit(tx, { tenantId: ctx.tenantId, actorType: 'user', actorId: ctx.userId, action: 'import', changes: { kind: input.kind, rows: done, skipped: errors.length } });
      return { ok: true as const, imported: done, skipped: errors.length };
    });
  } catch (e) {
    if (e instanceof Rollback) return fail(e.errors.length ? 'has_errors' : 'nothing_to_import');
    throw e;
  }
}

async function dryRun(db: Db, ctx: Ctx, kind: 'products' | 'customers', rows: string[][]): Promise<RowError[]> {
  try {
    await withTenant(db, ctx.tenantId, async (tx) => { throw new Rollback((await importRows(tx, ctx, kind, rows)).errors, 0); });
  } catch (e) {
    if (e instanceof Rollback) return e.errors;
    throw e;
  }
  return [];
}

/** Creates each row; a refused row is reported and skipped (every refusal comes before that row writes anything). */
async function importRows(tx: Tx, ctx: Ctx, kind: 'products' | 'customers', rows: string[][]): Promise<{ errors: RowError[]; done: number }> {
  const errors: RowError[] = [];
  let done = 0;
  const seen = new Map<string, number>();
  const firstLine = (key: string, line: number) => { const first = seen.get(key); if (first) return first; seen.set(key, line); return 0; };
  if (kind === 'customers') {
    const phones = rows.map((r) => normaliseGhanaPhone(r[1]));
    const known = phones.filter((p): p is string => Boolean(p));
    const taken = new Set(known.length ? (await tx.select({ phone: customers.phone }).from(customers).where(inArray(customers.phone, known))).map((c) => c.phone) : []);
    for (const [i, [name, rawPhone]] of rows.entries()) {
      const line = i + 2;
      const phone = phones[i];
      if (!name || name.length > 80) { errors.push({ row: line, message: 'name is required (up to 80 letters)' }); continue; }
      if (!phone) { errors.push({ row: line, message: `"${rawPhone}" is not a Ghana phone number` }); continue; }
      if (taken.has(phone)) { errors.push({ row: line, message: 'a customer with this phone already exists' }); continue; }
      const dup = firstLine(`phone:${phone}`, line);
      if (dup) { errors.push({ row: line, message: `same phone as line ${dup}` }); continue; }
      await tx.insert(customers).values({ tenantId: ctx.tenantId, name, phone });
      done++;
    }
    return { errors, done };
  }
  for (const [i, [name, sku, barcode, price, cost, unit, fractions, tracking, genericName, rxOnly]] of rows.entries()) {
    const line = i + 2;
    const pricePesewas = parseCedis(price);
    const costPesewas = cost ? parseCedis(cost) : 0;
    const track = (tracking || 'none').toLowerCase();
    const problem = !name ? 'name is required' : pricePesewas === null ? `price "${price}" must be in cedis, like 12.50` : costPesewas === null ? `cost "${cost}" must be in cedis`
      : !['none', 'batch', 'serial'].includes(track) ? 'tracking must be none, batch, or serial' : !yesNo(fractions) || !yesNo(rxOnly) ? 'use yes or no' : null;
    if (problem) { errors.push({ row: line, message: problem }); continue; }
    const dup = (sku && firstLine(`sku:${sku.toUpperCase()}`, line)) || (barcode && firstLine(`barcode:${barcode}`, line));
    if (dup) { errors.push({ row: line, message: `same SKU or barcode as line ${dup}` }); continue; }
    const r = await createProductTx(tx, ctx, {
      name, kind: 'standard', tracking: track as 'none' | 'batch' | 'serial', baseUnit: unit || 'piece', allowsFractions: yes(fractions),
      variants: [{ sku: sku || undefined, barcodes: barcode ? [barcode] : [], basePricePesewas: pricePesewas!, costPesewas: costPesewas! }],
      ...(genericName || yes(rxOnly) ? { pharmacy: { genericName: genericName || undefined, prescriptionOnly: yes(rxOnly) } } : {}),
    });
    if (!r.ok) { errors.push({ row: line, message: `${MESSAGES[r.error] ?? r.error.replaceAll('_', ' ')}${r.detail ? ` (${r.detail})` : ''}` }); continue; }
    done++;
  }
  return { errors, done };
}

/** Opening stock rows as receive lines (items found by barcode or SKU); one receipt saves them all or none. */
async function stockLines(db: Db, ctx: Ctx, rows: string[][]): Promise<{ lines: ReceiveLine[]; errors: RowError[] }> {
  const lines: ReceiveLine[] = [];
  const errors: RowError[] = [];
  for (const [i, [code, quantity, totalCost, batchNumber, expiryDate]] of rows.entries()) {
    const line = i + 2;
    const item = code ? await lookupStockItem(db, ctx, code, 'import_data') : null;
    const qty = parseQuantity(quantity);
    const cost = totalCost ? parseCedis(totalCost) : 0;
    const problem = !item ? `no item has the barcode or SKU "${code}"` : !qty || qty === '0.000' ? 'check the quantity' : cost === null ? `total cost "${totalCost}" must be in cedis`
      : item.tracking === 'serial' ? 'serial items are received on the stock screen, one serial at a time'
        : item.tracking === 'batch' && (!batchNumber || !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) ? 'batch number and expiry date (YYYY-MM-DD) are needed' : null;
    if (problem || !item) { errors.push({ row: line, message: problem ?? 'check the row' }); continue; }
    lines.push({ variantId: item.variantId, unitId: item.unitId, quantity: qty!, totalCostPesewas: cost!, ...(item.tracking === 'batch' ? { batchNumber, expiryDate } : {}) });
  }
  return { lines, errors };
}

export const importMessage = (e: ImportFail): string => ({
  invalid_input: 'That file could not be read as CSV.', too_large: `Files can have at most ${MAX_ROWS.toLocaleString('en-GH')} rows and 5 MB.`,
  wrong_headers: `The first line must be exactly: ${e.detail ?? ''}`,
  has_errors: e.detail ? `Nothing was imported: ${e.detail}.` : 'Some rows have errors. Fix them, or tick "Skip rows with errors".',
  nothing_to_import: 'There are no rows to import.',
}[e.error]);
