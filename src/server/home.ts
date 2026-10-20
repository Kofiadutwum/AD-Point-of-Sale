import 'server-only';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditLog, subscriptions, tenants } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { addDays, daysBetween, todayIn } from '@/lib/dates';
import type { RolePreset } from '@/lib/permissions';
import type { SubscriptionState } from '@/lib/subscription';
import type { Ctx } from './context';

export type HomeSummary = {
  shopName: string; userName: string; rolePreset: RolePreset; banner: string | null;
  securityEvents: Array<{ action: string; at: Date; detail: string }>;
};

const SECURITY_ACTIONS = [
  'failed_sign_in', 'pin_locked', 'staff_deactivated', 'device_registered', 'device_deregistered', 'mfa_enabled', 'mfa_disabled', 'mfa_reset',
];

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

function bannerFor(state: SubscriptionState, sub: { endDate: string; graceDays: number }, today: string): string | null {
  switch (state) {
    case 'trial': {
      const left = daysBetween(today, sub.endDate);
      return left === 0 ? 'Free trial: last day today.' : `Free trial: ${days(left)} left.`;
    }
    case 'grace': {
      const left = daysBetween(today, addDays(sub.endDate, sub.graceDays));
      return left === 0
        ? `Your subscription ended on ${sub.endDate}. Renew today to keep selling.`
        : `Your subscription ended on ${sub.endDate}. Renew within ${days(left)} to keep selling.`;
    }
    case 'read_only':
      return 'Your subscription has ended. You can view and export records. Renew to sell again.';
    default:
      return null;
  }
}

export async function getHomeSummary(db: Db, ctx: Ctx, now: Date): Promise<HomeSummary> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [shop] = await tx.select({ name: tenants.name, sub: subscriptions }).from(tenants)
      .innerJoin(subscriptions, eq(subscriptions.tenantId, tenants.id)).where(eq(tenants.id, ctx.tenantId));
    const events = ctx.permissions.includes('view_dashboard')
      ? await tx.select().from(auditLog)
        .where(and(eq(auditLog.tenantId, ctx.tenantId), inArray(auditLog.action, SECURITY_ACTIONS)))
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(10)
      : [];
    return {
      shopName: shop.name,
      userName: ctx.name,
      rolePreset: ctx.rolePreset,
      banner: bannerFor(ctx.subscription, shop.sub, todayIn(ctx.timezone, now)),
      securityEvents: events.map((e) => ({
        action: e.action,
        at: e.createdAt,
        detail: e.action === 'failed_sign_in' ? String(e.changes?.identifier ?? '') : (e.reason ?? e.recordId ?? ''),
      })),
    };
  });
}
