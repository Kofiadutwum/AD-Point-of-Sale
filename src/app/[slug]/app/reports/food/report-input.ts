import { todayIn } from '@/lib/dates';
import type { FoodReportInput } from '@/server/food-reports';

export type ReportSearch = { from?: string; to?: string; branch?: string; mode?: string };

/** The report filters from the address bar; today in Ghana when no dates are given. */
export function reportInput(s: ReportSearch): FoodReportInput {
  // shortcut: every shop is in Ghana (UTC+0) today; read the shop timezone when other countries join
  const today = todayIn('Africa/Accra', new Date());
  return {
    from: s.from || today, to: s.to || s.from || today, ...(s.branch ? { branchId: s.branch } : {}),
    ...(s.mode === 'counter' || s.mode === 'quick' ? { serviceMode: s.mode } : {}),
  };
}
