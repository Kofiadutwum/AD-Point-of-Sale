import { expect, it } from 'vitest';
import { addDays, addMonths, businessDate, maxDate, todayIn } from '@/lib/dates';
import { type SubscriptionStatus, subscriptionState } from '@/lib/subscription';

it('computes dates in the shop timezone', () => {
  expect(todayIn('Africa/Accra', new Date('2026-10-20T23:30:00Z'))).toBe('2026-10-20');
  expect(addDays('2026-10-20', 14)).toBe('2026-11-03');
  expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  expect(addMonths('2026-10-20', 12)).toBe('2027-10-20');
  expect(maxDate('2026-09-01', '2026-10-20')).toBe('2026-10-20');
});

it('derives the subscription state with a 14-day grace period for paid plans only', () => {
  const s = (status: SubscriptionStatus, endDate: string) => subscriptionState({ status, endDate, graceDays: 14 }, '2026-10-20');
  expect(s('trial', '2026-10-20')).toBe('trial');
  expect(s('trial', '2026-10-19')).toBe('read_only');
  expect(s('active', '2026-10-20')).toBe('active');
  expect(s('active', '2026-10-19')).toBe('grace');
  expect(s('active', '2026-10-06')).toBe('grace');
  expect(s('active', '2026-10-05')).toBe('read_only');
  expect(s('cancelled', '2026-12-31')).toBe('active');
});

it('works out the business date with a cutoff', () => {
  expect(businessDate('Africa/Accra', '00:00', new Date('2026-10-20T23:30:00Z'))).toBe('2026-10-20');
  expect(businessDate('Africa/Accra', '04:00', new Date('2026-10-21T02:00:00Z'))).toBe('2026-10-20');
  expect(businessDate('Africa/Accra', '04:00', new Date('2026-10-21T04:00:00Z'))).toBe('2026-10-21');
});
