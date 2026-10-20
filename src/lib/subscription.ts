import { daysBetween } from './dates';

export type SubscriptionStatus = 'trial' | 'active' | 'cancelled';
export type SubscriptionState = 'trial' | 'active' | 'grace' | 'read_only';

/** Paid plans get a grace period after the end date; trials go straight to read-only. */
export function subscriptionState(
  sub: { status: SubscriptionStatus; endDate: string; graceDays: number },
  today: string,
): SubscriptionState {
  if (sub.endDate >= today) return sub.status === 'trial' ? 'trial' : 'active';
  if (sub.status === 'trial') return 'read_only';
  return daysBetween(sub.endDate, today) <= sub.graceDays ? 'grace' : 'read_only';
}
