import { timingSafeEqual } from 'node:crypto';
import { getDb } from '@/db/client';
import { queueDueReports, runNotifications } from '@/server/notifications';
import { sendSms } from '@/server/sms';

const authorised = (header: string | null) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Spec 6.15-6.17: a scheduler calls this every 15 minutes with `Authorization: Bearer $CRON_SECRET`. */
export async function GET(request: Request) {
  if (!authorised(request.headers.get('authorization'))) return new Response('Not found', { status: 404 });
  const db = getDb();
  const now = new Date();
  const queued = await queueDueReports(db, now);
  const result = await runNotifications(db, now, sendSms);
  return Response.json({ queued, ...result });
}
