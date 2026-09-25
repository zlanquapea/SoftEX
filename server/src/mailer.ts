import nodemailer from 'nodemailer';
import type { Ctx, MailTransport } from './context.js';
import type { Row } from './db.js';
import { newId, now } from './util.js';

/**
 * Transactional email. Every message is written to the `outbound_emails` outbox
 * first and delivered by a background job with retries, so a slow or failing
 * mail server never blocks a request and nothing is silently lost.
 */

export interface EmailInput {
  workspaceId?: string | null;
  kind: string;
  to: string;
  subject: string;
  /** Plain-text body; the HTML version is generated from it. */
  text: string;
  action?: { label: string; url: string };
  attachments?: { filename: string; content: string; contentType?: string }[];
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderHtml(subject: string, text: string, action?: { label: string; url: string }) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;line-height:1.55">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const button = action
    ? `<p style="margin:22px 0"><a href="${escapeHtml(action.url)}" style="background:#b5461b;color:#fff;padding:11px 18px;border-radius:9px;text-decoration:none;font-weight:600;display:inline-block">${escapeHtml(action.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#fef6eb;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#2b1d16">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fffcf7;border:1px solid #eadfd1;border-radius:14px;padding:28px">
<tr><td>
<div style="margin-bottom:18px"><span style="font-weight:800;font-size:26px;letter-spacing:-0.02em;color:#b5461b">Küü</span><br><span style="font-size:12px;color:#8a3314">Work moves forward together.</span></div>
<h1 style="font-size:19px;margin:0 0 14px">${escapeHtml(subject)}</h1>
${paragraphs}${button}
<p style="margin:26px 0 0;color:#7a695e;font-size:12px">You are receiving this because of your Küü account. You can change email preferences in Settings → Notifications.</p>
</td></tr></table></td></tr></table></body></html>`;
}

export async function queueEmail(ctx: Ctx, input: EmailInput) {
  const text = input.action ? `${input.text}\n\n${input.action.label}: ${input.action.url}` : input.text;
  const id = newId();
  await ctx.db.insert('outbound_emails', {
    id,
    workspace_id: input.workspaceId ?? null,
    kind: input.kind,
    to_email: input.to,
    subject: input.subject,
    text,
    html: renderHtml(input.subject, input.text, input.action),
    attachments: input.attachments ?? [],
    next_attempt_at: now(),
    created_at: now(),
  });
  return id;
}

let cachedTransport: { url: string; transport: MailTransport } | null = null;

function transportFor(ctx: Ctx): MailTransport | null {
  if (ctx.mail) return ctx.mail;
  if (!ctx.config.smtpUrl) return null;
  if (cachedTransport?.url !== ctx.config.smtpUrl) {
    cachedTransport = { url: ctx.config.smtpUrl, transport: nodemailer.createTransport(ctx.config.smtpUrl) as MailTransport };
  }
  return cachedTransport.transport;
}

const MAX_ATTEMPTS = 6;

/** Deliver due emails. Returns the number processed. */
export async function processEmailQueue(ctx: Ctx, limit = 20) {
  const due = await ctx.db.all(
    `SELECT * FROM outbound_emails WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY created_at LIMIT ?`,
    now(),
    limit,
  );
  const transport = transportFor(ctx);
  for (const email of due) {
    if (!transport) {
      // No SMTP configured: keep a record and log it so developers can follow links.
      await ctx.db.run(`UPDATE outbound_emails SET status = 'logged', last_error = ? WHERE id = ?`, 'Not delivered: SMTP is not configured', email.id);
      if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) console.log(`[mail:log] to=${email.to_email} subject="${email.subject}"\n${email.text}\n`);
      continue;
    }
    await deliver(ctx, transport, email);
  }
  return due.length;
}

async function deliver(ctx: Ctx, transport: MailTransport, email: Row) {
  try {
    await transport.sendMail({
      from: ctx.config.mailFrom,
      to: email.to_email,
      subject: email.subject,
      text: email.text,
      html: email.html || undefined,
      attachments: JSON.parse(email.attachments),
    });
    await ctx.db.run(`UPDATE outbound_emails SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?`, now(), email.id);
  } catch (error) {
    const attempts = email.attempts + 1;
    const backoffMs = Math.min(6 * 3_600_000, 60_000 * 2 ** attempts);
    await ctx.db.run(
      `UPDATE outbound_emails SET attempts = ?, last_error = ?, status = ?, next_attempt_at = ? WHERE id = ?`,
      attempts,
      String((error as Error).message).slice(0, 500),
      attempts >= MAX_ATTEMPTS ? 'failed' : 'queued',
      new Date(Date.now() + backoffMs).toISOString(),
      email.id,
    );
  }
}

const localHour = (tz: string, at = new Date()) => {
  try {
    return Number(at.toLocaleString('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }));
  } catch {
    return at.getUTCHours();
  }
};

/**
 * Daily digest (§5.5): at 08:00 in each person's time zone, email a summary of
 * notifications they have not read in the app. Skipped when there is nothing new.
 */
export async function queueDigests(ctx: Ctx, at = new Date()) {
  const users = await ctx.db.all(
    `SELECT u.*, m.workspace_id, w.name AS workspace_name FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.deactivated_at IS NULL
       JOIN workspaces w ON w.id = m.workspace_id
      WHERE u.email_digest = 1`,
  );
  let queued = 0;
  for (const u of users) {
    if (localHour(u.timezone, at) !== 8) continue;
    const since = u.last_digest_at && u.last_digest_at > new Date(at.getTime() - 20 * 3_600_000).toISOString() ? null : u.last_digest_at ?? '';
    if (since === null) continue;
    const items = await ctx.db.all(
      `SELECT title, link, kind FROM notifications WHERE user_id = ? AND workspace_id = ? AND read_at IS NULL AND created_at > ?
        ORDER BY urgent DESC, created_at DESC LIMIT 15`,
      u.id,
      u.workspace_id,
      since,
    );
    await ctx.db.run('UPDATE users SET last_digest_at = ? WHERE id = ?', at.toISOString(), u.id);
    if (!items.length) continue;
    const total = (await ctx.db.get(
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND workspace_id = ? AND read_at IS NULL AND created_at > ?',
      u.id,
      u.workspace_id,
      since,
    ))!.n;
    await queueEmail(ctx, {
      workspaceId: u.workspace_id,
      kind: 'digest',
      to: u.email,
      subject: `Your Küü digest: ${total} update${total === 1 ? '' : 's'} in ${u.workspace_name}`,
      text: `Good morning ${u.name.split(' ')[0]},\n\nHere is what needs your attention:\n\n${items.map((i) => `• ${i.title}`).join('\n')}${total > items.length ? `\n\n…and ${total - items.length} more.` : ''}`,
      action: { label: 'Open your inbox', url: `${ctx.config.publicUrl}/inbox` },
    });
    queued += 1;
  }
  return queued;
}
