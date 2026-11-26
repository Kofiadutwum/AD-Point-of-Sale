import type { SlipLine } from './escpos';

export type KitchenStation = 'kitchen' | 'bar' | 'grill';
export type KitchenSlipOrder = {
  kind: 'new' | 'cancel'; orderNumber: string | null; label?: string | null; // a table or ticket name
  dining: 'eat_in' | 'takeaway' | 'delivery'; at: Date; timezone: string; by?: string;
  lines: Array<{ name: string; quantity: string; station: KitchenStation; addOns?: string[]; note?: string | null }>;
};

const DINING = { eat_in: 'EAT IN', takeaway: 'TAKEAWAY', delivery: 'DELIVERY' } as const;
const qty = (q: string) => String(Number(q));

/** Spec 4.24: one slip per station (food to the kitchen, drinks to the bar), with only that station's items; a void prints a cancel slip. */
export function kitchenSlips(order: KitchenSlipOrder): Array<{ station: KitchenStation; lines: SlipLine[] }> {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: order.timezone, hour: '2-digit', minute: '2-digit' }).format(order.at);
  const stations = [...new Set(order.lines.map((l) => l.station))];
  return stations.map((station) => {
    const head: SlipLine[] = [
      { text: station.toUpperCase(), center: true, bold: true },
      ...(order.kind === 'cancel' ? [{ text: '*** CANCEL ***', center: true, bold: true, big: true }] : []),
      ...(order.orderNumber ? [{ text: `Order ${order.orderNumber}`, center: true, big: true }] : []),
      ...(order.label ? [{ text: order.label, center: true, bold: true }] : []),
      { text: `${DINING[order.dining]}  ${time}`, center: true },
      { text: '-'.repeat(32) },
    ];
    const items = order.lines.filter((l) => l.station === station).flatMap((l): SlipLine[] => [
      { text: `${qty(l.quantity)} x ${l.name}`, bold: true, big: true },
      ...(l.addOns ?? []).map((a) => ({ text: `  + ${a}` })),
      ...(l.note ? [{ text: `  ! ${l.note}`, bold: true }] : []),
    ]);
    return { station, lines: [...head, ...items, { text: '-'.repeat(32) }, ...(order.by ? [{ text: `By ${order.by}` }] : [])] };
  });
}
