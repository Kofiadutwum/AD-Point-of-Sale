# Phase 2-5 hand-over: daily, weekly, and marketing SMS

Spec 4.8, 4.25, 6.15, 6.16, 6.17, 6.42.

## What was built

- **Schema** (migrations 0040, 0041): `notifications` (one SMS to one phone; unique key per shop so a job that runs twice queues once; status queued/sent/failed/blocked_quota; attempts; send_after), `marketing_opt_outs`, `sms_campaigns`; `customers.marketing_consent`; tenants `sms_reports`, `report_time` (default 21:00), `weekly_report_day` (0 = Sunday). RLS on the new tables. Permission `marketing` (owner, manager; not on a till PIN).
- `src/lib/sms-text.ts` `smsParts` (160/153 plain, 70/67 Unicode).
- `src/server/sms.ts` `sendSms`: Arkesel API with `SMS_API_KEY` and `SMS_SENDER_ID`; prints to the console when no key is set.
- `src/server/notifications.ts`: `dailySummary`, `weeklyStockSummary`, `queueDueReports(db, now)` (shops with SMS reports on and a manager phone, once the shop's report time has passed; weekly on the chosen day), `runNotifications(db, now, send)` (oldest first; blocks past the plan's `sms_per_month` parts; 3 attempts, 5 minutes apart), `smsUsage`.
- `src/server/marketing.ts`: segments all / recent (30 days) / lapsed (bought, but not in 60 days); `previewCampaign` (recipients × parts against what is left); `sendCampaign` (needs the confirmed cost; refuses past the allowance; quiet hours 21:00–07:00 move sends to 07:00; every message ends with the opt-out link); `setMarketingConsent` (staff cannot override a customer's opt-out); public `optOut` (also cancels queued promotional SMS); `listCampaigns`.
- **Screens**: `/app/marketing` (check cost, then send; recent campaigns; usage), public `/[slug]/stop`, settings "Reports by SMS", consent checkbox on the customer page, home link "Promotional SMS".
- **Cron**: `GET /api/cron/notifications` with `Authorization: Bearer $CRON_SECRET` (404 otherwise); call it every 15 minutes.

## Tests

`tests/server/sms.test.ts` (5).

## Setup before launch

- Set `CRON_SECRET`, `SMS_API_KEY`, `SMS_SENDER_ID` and schedule the cron call. Register the sender ID with the provider early (approval takes time).

## Not done / notes

- Reports are shop-wide, not per branch; email copies of reports are not sent.
- Refunds and cash differences in the daily report are dated in UTC (Ghana time).
- The owner notice when SMS are blocked by the allowance is the usage line on the marketing page only.
- Opt-out by SMS reply ("STOP") needs provider support; the link is used instead.
