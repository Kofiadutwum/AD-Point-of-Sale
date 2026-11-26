import { timingSafeEqual } from 'node:crypto';
import { getDb } from '@/db/client';
import { runBillingJob } from '@/server/billing';
import { queueDueReports, runNotifications } from '@/server/notifications';
import { expireOnlineOrders } from '@/server/online-orders';
import { expireAllPoints } from '@/server/rewards';
import { runWebhookDeliveries } from '@/server/webhooks';
import { paystack } from '@/server/paystack';
import { sendSms } from '@/server/sms';

const authorised = (header: string | null) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Spec 6.15-6.17, 6.20: a scheduler calls this every 15 minutes with `Authorization: Bearer $CRON_SECRET`. */
export async function GET(request: Request) {
  if (!authorised(request.headers.get('authorization'))) return new Response('Not found', { status: 404 });
  const db = getDb();
  const now = new Date();
  const queued = await queueDueReports(db, now);
  const billing = await runBillingJob(db, now, paystack); // reminders and renewals; keys make every-15-minute runs safe
  const expiredOrders = await expireOnlineOrders(db, now); // spec 6.49: before sending, so the lapse SMS goes out this run
  const result = await runNotifications(db, now, sendSms);
  const webhooks = await runWebhookDeliveries(db, now);
  const expiredPoints = now.getUTCHours() === 2 ? await expireAllPoints(db, now) : 0; // once a day, in the 02:00 UTC runs (repeats are harmless)
  return Response.json({ queued, billing, expiredOrders, webhooks, expiredPoints, ...result });
}
