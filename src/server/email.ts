import 'server-only';
import { Resend } from 'resend';

let client: Resend | undefined;

/** Sends through Resend; without RESEND_API_KEY (local development) the message is printed instead. */
export async function sendEmail(msg: { to: string; subject: string; text: string }): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.info(`[email to ${msg.to}] ${msg.subject}\n${msg.text}`);
    return;
  }
  client ??= new Resend(key);
  const { error } = await client.emails.send({
    from: process.env.EMAIL_FROM ?? 'no-reply@example.com', to: msg.to, subject: msg.subject, text: msg.text,
  });
  if (error) throw new Error(`email failed: ${error.message}`);
}
