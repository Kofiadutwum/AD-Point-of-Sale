import { ActionForm, Check, Field } from '@/components/form';
import { formatCedis } from '@/lib/money';
import type { ComboSlotInput } from '@/server/combos';
import { addComboSlotAction, removeComboSlotAction } from './actions';

type Slot = ComboSlotInput & { id: string; choiceNames: Record<string, string> };

/** Spec 6.52: a combo's choice slots, such as "Drink: pick 1", with upgrade prices. Fixed items are the components above. */
export function ComboSlots({ slug, productId, variantId, slots, items }: {
  slug: string; productId: string; variantId: string; slots: Slot[]; items: Array<{ variantId: string; label: string }>;
}) {
  return (
    <section className="flex flex-col gap-3 rounded border p-3">
      <h3 className="font-medium">Choice slots</h3>
      {slots.length === 0 && <p className="text-sm text-gray-700">No slots yet. Add one for each choice the customer makes, such as the drink.</p>}
      <ul className="flex flex-col gap-2 text-sm">
        {slots.map((s) => (
          <li key={s.id} className="flex flex-wrap items-start justify-between gap-2">
            <span>
              <span className="font-medium">{s.name}</span> (pick {s.minChoices === s.maxChoices ? s.maxChoices : `${s.minChoices}–${s.maxChoices}`}):{' '}
              {s.choices.map((c) => `${s.choiceNames[c.variantId]}${c.upgradePesewas ? ` +${formatCedis(c.upgradePesewas)}` : ''}`).join(', ')}
            </span>
            <ActionForm action={removeComboSlotAction.bind(null, slug, productId, variantId, s.id)} submitLabel="Remove slot">{null}</ActionForm>
          </li>
        ))}
      </ul>
      <details>
        <summary className="cursor-pointer text-sm text-blue-800">Add a slot</summary>
        <ActionForm action={addComboSlotAction.bind(null, slug, productId, variantId)} submitLabel="Add slot">
          <Field label="Slot name (e.g. Drink)" name="slotName" maxLength={40} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="Pick at least" name="minChoices" type="number" min={0} max={30} defaultValue={1} />
            <Field label="Pick at most" name="maxChoices" type="number" min={1} max={30} defaultValue={1} />
          </div>
          <fieldset className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded border p-2">
            <legend className="text-sm">Items on offer (extra price for upgrades)</legend>
            {items.map((i) => (
              <div key={i.variantId} className="flex items-center justify-between gap-2">
                <Check name="choice" value={i.variantId} label={i.label} />
                <input name={`upgrade-${i.variantId}`} inputMode="decimal" placeholder="+GHS" aria-label={`Extra price for ${i.label}`} className="w-20 rounded border px-2 py-1 text-sm" />
              </div>
            ))}
          </fieldset>
        </ActionForm>
      </details>
    </section>
  );
}
