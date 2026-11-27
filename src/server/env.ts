// Phase 8 (launch readiness): the settings production cannot run without, checked once at start-up.
// Errors stop a production server from starting; warnings are logged. Values are never printed.

export type EnvReport = { errors: string[]; warnings: string[] };

const set = (env: NodeJS.ProcessEnv, k: string) => !!env[k]?.trim();

export function checkEnv(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prod = env.NODE_ENV === 'production';
  const need = (ok: boolean, message: string) => { if (!ok) (prod ? errors : warnings).push(message); };

  need(set(env, 'DATABASE_URL'), 'DATABASE_URL is not set: the server would use local PGlite, which loses data on serverless hosts.');
  let appUrl: URL | null = null;
  try { appUrl = env.APP_URL ? new URL(env.APP_URL) : null; } catch { appUrl = null; }
  need(!!appUrl && (appUrl.protocol === 'https:' || !prod), 'APP_URL must be the public https:// address (receipt links, Paystack returns, emails use it).');
  const mfa = env.MFA_SECRET_KEY ? Buffer.from(env.MFA_SECRET_KEY, 'base64') : null;
  need(!!mfa && mfa.length === 32, 'MFA_SECRET_KEY must be 32 random bytes in base64: it seals MFA secrets, Paystack keys, webhook secrets and gift codes.');
  need((env.CRON_SECRET?.length ?? 0) >= 32, 'CRON_SECRET must be at least 32 characters (it guards the cron job and the domain lookup).');
  need(set(env, 'RESEND_API_KEY'), 'RESEND_API_KEY is not set: password resets and billing emails will not be sent.');
  const r2 = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter((k) => set(env, k));
  need(r2.length === 4, 'R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET must all be set: local disk photos are lost on serverless hosts.');

  // useful but not fatal
  if (!set(env, 'SMS_API_KEY')) warnings.push('SMS_API_KEY is not set: SMS (reports, order updates, sign-up codes) are only printed to the log.');
  if (!set(env, 'PAYSTACK_SECRET_KEY')) warnings.push('PAYSTACK_SECRET_KEY is not set: shops cannot pay subscriptions online.');
  if (env.PAYSTACK_SECRET_KEY?.startsWith('sk_test_') && prod) warnings.push('PAYSTACK_SECRET_KEY is a test key in production.');
  if (!set(env, 'REPORT_EMAIL')) warnings.push('REPORT_EMAIL is not set: storefront "Report this page" links go to a placeholder address.');
  return { errors, warnings };
}
