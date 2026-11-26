'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { checkImport, type ImportKind, importMessage, runImport, TEMPLATES } from '@/server/csv-import';
import { pageCtx } from '../page-ctx';

const KINDS = Object.keys(TEMPLATES) as ImportKind[];

/** Spec 6.45: "Check file" lists errors by line and previews the first rows; "Import" saves them (all, or all but the failing rows when ticked). */
export async function importAction(slug: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'import_data');
  const kind = String(fd.get('kind') ?? '') as ImportKind;
  const file = fd.get('file');
  if (!KINDS.includes(kind) || !(file instanceof File) || file.size === 0) return { error: 'Choose what you are importing and a CSV file.' };
  if (file.size > 5 * 1024 * 1024) return { error: 'Files can be at most 5 MB.' };
  const text = await file.text();
  if (fd.get('step') === 'check') {
    const c = await checkImport(getDb(), ctx, { kind, text });
    if (!c.ok) return { error: importMessage(c) };
    const shown = c.errors.slice(0, 20).map((e) => `line ${e.row}: ${e.message}`).join('; ');
    const preview = c.preview.slice(0, 5).map((r) => r[0]).join(', ');
    return c.errors.length
      ? { error: `${c.errors.length} of ${c.rows} rows have errors: ${shown}${c.errors.length > 20 ? '; …' : ''}` }
      : { error: null, message: `All ${c.rows} rows are ready to import. First rows: ${preview}.` };
  }
  const r = await runImport(getDb(), ctx, { kind, text, branchId: String(fd.get('branchId') ?? ''), skipFailing: fd.get('skip') === 'on' }, new Date());
  if (!r.ok) return { error: importMessage(r) };
  revalidatePath(`/${slug}/app/import`);
  return { error: null, message: `Imported ${r.imported} rows${r.skipped ? `, skipped ${r.skipped} with errors` : ''}.` };
}
