'use server';
import { revalidatePath } from 'next/cache';
import type { FormState } from '@/components/form';
import { getDb } from '@/db/client';
import { parseCedis } from '@/lib/money';
import { type AddOnOptionInput, saveAddOnGroup } from '@/server/add-ons';
import { pageCtx } from '../page-ctx';

const MESSAGES: Record<string, string> = {
  invalid_input: 'Check the name, the minimum and maximum, and each option (an ingredient needs a quantity).',
  duplicate_name: 'Another group already has that name.', unknown_item: 'Pick an ingredient from the list.',
  not_found: 'That group changed. Reload the page.', module_off: 'Turn on the kitchen module first.',
};
const text = (fd: FormData, key: string) => String(fd.get(key) ?? '').trim();
const OPTION_ROWS = 30; // the most options a group holds

export async function saveAddOnGroupAction(slug: string, groupId: string | null, _prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await pageCtx(slug, 'manage_products');
  const options: AddOnOptionInput[] = [];
  for (let i = 0; i < OPTION_ROWS; i++) {
    const name = text(fd, `name-${i}`);
    if (!name) continue; // a blank row is left out, which makes a saved option inactive
    const ingredient = text(fd, `ingredient-${i}`);
    options.push({
      ...(text(fd, `id-${i}`) ? { id: text(fd, `id-${i}`) } : {}), name, pricePesewas: parseCedis(text(fd, `price-${i}`) || '0') ?? -1,
      ingredientVariantId: ingredient || null, ingredientQuantity: ingredient ? text(fd, `quantity-${i}`) || '1' : null,
    });
  }
  const r = await saveAddOnGroup(getDb(), ctx, {
    ...(groupId ? { id: groupId } : {}), name: text(fd, 'name'), minChoices: Number(text(fd, 'min')), maxChoices: Number(text(fd, 'max')), options,
  });
  if (!r.ok) return { error: MESSAGES[r.error] ?? 'Something went wrong. Try again.' };
  revalidatePath(`/${slug}/app/add-ons`);
  return { error: null, message: 'Add-on group saved.' };
}
