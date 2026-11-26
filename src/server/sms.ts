import 'server-only';

export type SendSms = (to: string, text: string) => Promise<void>;

/** Sends through Arkesel (a Ghanaian SMS provider) with the registered sender ID; without SMS_API_KEY (local development) the message is printed instead. */
export const sendSms: SendSms = async (to, text) => {
  const key = process.env.SMS_API_KEY;
  if (!key) {
    console.info(`[sms to ${to}] ${text}`);
    return;
  }
  const res = await fetch('https://sms.arkesel.com/api/v2/sms/send', {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: process.env.SMS_SENDER_ID ?? 'ADsmartshop', message: text, recipients: [to] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`sms failed: HTTP ${res.status}`);
};
