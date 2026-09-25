import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireRole, type Auth } from '../access.js';
import { audit, authOf, notify, platformEvent, type Ctx } from '../context.js';
import type { Row } from '../db.js';
import { queueEmail } from '../mailer.js';
import {
  GRACE_DAYS,
  TERMS_VERSION,
  activeMemberCount,
  aiUsedThisMonth,
  billableSeats,
  effectivePlan,
  isOperator,
  isSaas,
  monthStart,
  planCatalog,
  priceFor,
  publicPlans,
  requireVerifiedEmail,
  storageUsed,
  type PlanId,
} from '../plans.js';
import { HttpError, badRequest, newId, notFound, now, parse, parseJson } from '../util.js';
import { backupLocation, createBackup, lastBackup, listBackups, openBackup } from '../backup.js';

/**
 * Billing for hosted (SaaS) servers.
 *
 * Card processors such as Stripe don't accept businesses registered in Liberia,
 * so payment is made the way most customers there already pay: Orange Money,
 * MTN Mobile Money or bank transfer. A workspace admin pays using the
 * operator's instructions and submits the transaction reference; the operator
 * confirms it in the operator console, which extends the paid period.
 */

export const PAYMENT_METHODS = {
  orange_money: 'Orange Money',
  mtn_momo: 'MTN Mobile Money',
  bank: 'Bank transfer',
  other: 'Other',
} as const;

const MONTH_OPTIONS = [1, 3, 6, 12] as const;

export function addMonths(from: Date, months: number) {
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

const money = (n: number) => `$${n.toFixed(2)}`;

async function paymentRow(db: Ctx['db'], p: Row) {
  return {
    id: p.id,
    plan: p.plan,
    months: p.months,
    seats: p.seats,
    amount: p.amount,
    method: p.method,
    method_label: PAYMENT_METHODS[p.method as keyof typeof PAYMENT_METHODS] ?? p.method,
    reference: p.reference,
    payer_name: p.payer_name,
    payer_phone: p.payer_phone,
    note: p.note,
    status: p.status,
    decision_note: p.decision_note,
    decided_at: p.decided_at,
    period_start: p.period_start,
    period_end: p.period_end,
    created_at: p.created_at,
    submitted_by: await db.get('SELECT id, name FROM users WHERE id = ?', p.submitted_by) ?? null,
  };
}

/** Owners and admins: the people told about billing. */
const billingContacts = async (ctx: Ctx, workspaceId: string) =>
  await ctx.db.all(
    `SELECT u.id, u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? AND m.role IN ('owner', 'admin') AND m.deactivated_at IS NULL`,
    workspaceId,
  );

async function tellBillingContacts(ctx: Ctx, workspaceId: string, subject: string, text: string, link = '/admin?tab=billing') {
  for (const person of await billingContacts(ctx, workspaceId)) {
    await notify(ctx, workspaceId, { userId: person.id, kind: 'billing', title: subject, body: text.split('\n')[0], link });
    await queueEmail(ctx, {
      workspaceId,
      kind: 'billing',
      to: person.email,
      subject,
      text: `Hi ${person.name.split(' ')[0]},\n\n${text}`,
      action: { label: 'Open billing', url: `${ctx.config.publicUrl}${link}` },
    });
  }
}

async function usage(ctx: Ctx, workspaceId: string) {
  const plan = await effectivePlan(ctx, workspaceId);
  return {
    members: await activeMemberCount(ctx.db, workspaceId),
    member_limit: plan.member_limit,
    seats: await billableSeats(ctx.db, workspaceId),
    storage_bytes: await storageUsed(ctx.db, workspaceId),
    storage_limit: plan.storage_limit,
    ai_used: await aiUsedThisMonth(ctx.db, workspaceId, plan.status === 'trial' ? new Date(0).toISOString() : monthStart()),
    ai_limit: plan.features.includes('ai') ? plan.ai_limit : 0,
  };
}

// ======================= Public =======================

export function publicBillingRouter(ctx: Ctx) {
  const r = Router();
  r.get('/public/plans', (_req, res) => {
    const b = ctx.config.billing;
    res.json({
      mode: ctx.config.mode,
      currency: 'USD',
      lrd_per_usd: b.lrdPerUsd ?? null,
      trial_days: b.trialDays,
      annual_factor: b.annualFactor,
      support_email: b.supportEmail ?? null,
      plans: publicPlans(ctx),
      company: {
        name: ctx.config.company.name ?? null,
        address: ctx.config.company.address ?? null,
        email: ctx.config.company.email ?? null,
      },
      terms_version: TERMS_VERSION,
    });
  });
  return r;
}

// ======================= Workspace billing =======================

export function billingRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  const requireSaas = () => {
    if (!isSaas(ctx)) throw notFound('Billing');
  };

  r.get('/billing', async (req, res) => {
    requireSaas();
    const auth = authOf(req);
    requireRole(auth, 'admin');
    const b = ctx.config.billing;
    res.json({
      plan: await effectivePlan(ctx, auth.workspaceId),
      usage: await usage(ctx, auth.workspaceId),
      plans: publicPlans(ctx),
      currency: 'USD',
      lrd_per_usd: b.lrdPerUsd ?? null,
      annual_factor: b.annualFactor,
      grace_days: GRACE_DAYS,
      month_options: MONTH_OPTIONS,
      methods: Object.entries(PAYMENT_METHODS).map(([id, label]) => ({ id, label })),
      instructions: b.paymentInstructions || null,
      support_email: b.supportEmail ?? null,
      payments: (await Promise.all((await db.all('SELECT * FROM payments WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 50', auth.workspaceId)).map((p) => paymentRow(db, p)))),
    });
  });

  r.post('/billing/payments', async (req, res) => {
    requireSaas();
    const auth = authOf(req);
    requireRole(auth, 'admin');
    await requireVerifiedEmail(ctx, auth);
    const body = parse(
      z.object({
        plan: z.enum(['standard', 'business']),
        months: z.number().int().refine((m) => (MONTH_OPTIONS as readonly number[]).includes(m), 'months must be 1, 3, 6 or 12'),
        method: z.enum(Object.keys(PAYMENT_METHODS) as [keyof typeof PAYMENT_METHODS]),
        reference: z.string().trim().min(3).max(100),
        payerName: z.string().trim().max(100).default(''),
        payerPhone: z.string().trim().max(40).default(''),
        note: z.string().trim().max(500).default(''),
      }),
      req.body,
    );
    const pending = (await db.get(`SELECT COUNT(*) AS n FROM payments WHERE workspace_id = ? AND status = 'pending'`, auth.workspaceId))!.n;
    if (pending >= 3) throw badRequest('You already have payments waiting for confirmation. Please wait for them to be reviewed.');
    if (await db.get(`SELECT 1 FROM payments WHERE reference = ? AND method = ? AND status IN ('pending', 'approved')`, body.reference, body.method)) {
      throw badRequest('A payment with this transaction reference has already been submitted');
    }
    const seats = await billableSeats(db, auth.workspaceId);
    const amount = priceFor(ctx, body.plan, seats, body.months);
    const id = newId();
    await db.insert('payments', {
      id,
      workspace_id: auth.workspaceId,
      submitted_by: auth.userId,
      plan: body.plan,
      months: body.months,
      seats,
      amount,
      method: body.method,
      reference: body.reference,
      payer_name: body.payerName,
      payer_phone: body.payerPhone,
      note: body.note,
      status: 'pending',
      created_at: now(),
    });
    await audit(ctx, auth.workspaceId, auth.userId, 'billing.payment_submitted', 'payment', id, { plan: body.plan, months: body.months, amount, method: body.method });
    const ws = (await db.get('SELECT name FROM workspaces WHERE id = ?', auth.workspaceId))!;
    for (const email of ctx.config.operatorEmails) {
      await queueEmail(ctx, {
        kind: 'operator_payment',
        to: email,
        subject: `Payment to confirm: ${ws.name} — ${money(amount)}`,
        text: `${ws.name} submitted a ${PAYMENT_METHODS[body.method]} payment of ${money(amount)} for ${body.months} month(s) of ${body.plan} (${seats} member${seats === 1 ? '' : 's'}).\n\nReference: ${body.reference}${body.payerPhone ? `\nPhone: ${body.payerPhone}` : ''}${body.payerName ? `\nName: ${body.payerName}` : ''}\n\nCheck it arrived, then approve or reject it in the operator console.`,
        action: { label: 'Open operator console', url: `${ctx.config.publicUrl}/operator` },
      });
    }
    res.status(201).json(await paymentRow(db, (await db.get('SELECT * FROM payments WHERE id = ?', id))!));
  });

  r.delete('/billing/payments/:id', async (req, res) => {
    requireSaas();
    const auth = authOf(req);
    requireRole(auth, 'admin');
    const p = await db.get(`SELECT * FROM payments WHERE id = ? AND workspace_id = ? AND status = 'pending'`, req.params.id, auth.workspaceId);
    if (!p) throw notFound('Pending payment');
    await db.run(`UPDATE payments SET status = 'cancelled', decided_at = ? WHERE id = ?`, now(), p.id);
    await audit(ctx, auth.workspaceId, auth.userId, 'billing.payment_cancelled', 'payment', p.id);
    res.json({ ok: true });
  });

  return r;
}

// ======================= Operator console =======================

export function operatorRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  // Only configured operators with a verified address and multifactor authentication. Everyone else gets 404.
  const operatorOnly = async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/operator')) return next();
    const auth = req.auth as Auth;
    const user = await db.get('SELECT email, mfa_enabled, email_verified_at FROM users WHERE id = ?', auth.userId);
    if (!user || !isOperator(ctx, user.email) || auth.tokenScope) return next(notFound('Page'));
    if (!user.mfa_enabled) return next(new HttpError(403, 'Turn on multifactor authentication in Settings before using the operator console', { code: 'operator_mfa' }));
    if (!user.email_verified_at) return next(new HttpError(403, 'Verify your email address before using the operator console'));
    next();
  };
  r.use(operatorOnly);

  const actor = async (req: Request) => (await db.get('SELECT email FROM users WHERE id = ?', (req.auth as Auth).userId))!.email as string;

  const workspaceSummary = async (ws: Row) => {
    const plan = await effectivePlan(ctx, ws);
    const owners = await db.all(
      `SELECT u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.role = 'owner' AND m.deactivated_at IS NULL`,
      ws.id,
    );
    return {
      id: ws.id,
      name: ws.name,
      created_at: ws.created_at,
      suspended_at: ws.suspended_at,
      suspended_reason: ws.suspended_reason,
      plan: { id: plan.id, name: plan.name, status: plan.status, purchased: plan.purchased, trial_ends_at: plan.trial_ends_at, paid_through: plan.paid_through },
      owners,
      usage: await usage(ctx, ws.id),
      last_active_at: (await db.get('SELECT MAX(created_at) AS t FROM sessions WHERE workspace_id = ?', ws.id))!.t ?? null,
      pending_payments: (await db.get(`SELECT COUNT(*) AS n FROM payments WHERE workspace_id = ? AND status = 'pending'`, ws.id))!.n,
    };
  };

  r.get('/operator/summary', async (_req, res) => {
    const all = await db.all('SELECT * FROM workspaces');
    const counts = { total: all.length, trial: 0, active: 0, grace: 0, free: 0, suspended: 0 };
    let mrr = 0;
    const catalog = planCatalog(ctx.config.billing);
    for (const ws of all) {
      if (ws.suspended_at) {
        counts.suspended += 1;
        continue;
      }
      const plan = await effectivePlan(ctx, ws);
      if (plan.status === 'trial' || plan.status === 'active' || plan.status === 'grace' || plan.status === 'free') counts[plan.status] += 1;
      if (plan.status === 'active' && plan.id !== 'unlimited') mrr += catalog[plan.id].price * await billableSeats(db, ws.id);
    }
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    res.json({
      workspaces: counts,
      signups_7d: (await db.get('SELECT COUNT(*) AS n FROM workspaces WHERE created_at >= ?', since))!.n,
      pending_payments: (await db.get(`SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'`))!.n,
      revenue_30d: (await db.get(`SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE status = 'approved' AND decided_at >= ?`, new Date(Date.now() - 30 * 86_400_000).toISOString()))!.n,
      mrr: Math.round(mrr * 100) / 100,
      users: (await db.get(`SELECT COUNT(*) AS n FROM users WHERE email NOT LIKE '%@deleted.invalid'`))!.n,
    });
  });

  r.get('/operator/workspaces', async (req, res) => {
    const q = parse(z.object({ q: z.string().max(100).optional(), status: z.enum(['trial', 'active', 'grace', 'free', 'suspended']).optional() }), req.query);
    const like = `%${(q.q ?? '').toLowerCase()}%`;
    const rows = await db.all(
      `SELECT DISTINCT w.* FROM workspaces w
         LEFT JOIN memberships m ON m.workspace_id = w.id AND m.role = 'owner' LEFT JOIN users u ON u.id = m.user_id
        WHERE (? = '%%' OR lower(w.name) LIKE ? OR lower(u.email) LIKE ?) ORDER BY w.created_at DESC LIMIT 500`,
      like,
      like,
      like,
    );
    const list = (await Promise.all(rows.map(workspaceSummary))).filter((w) => (q.status === 'suspended' ? !!w.suspended_at : !q.status || (!w.suspended_at && w.plan.status === q.status)));
    res.json(list.slice(0, 200));
  });

  r.get('/operator/workspaces/:id', async (req, res) => {
    const ws = await db.get('SELECT * FROM workspaces WHERE id = ?', req.params.id);
    if (!ws) throw notFound('Workspace');
    res.json({
      ...await workspaceSummary(ws),
      payments: (await Promise.all((await db.all('SELECT * FROM payments WHERE workspace_id = ? ORDER BY created_at DESC', ws.id)).map((p) => paymentRow(db, p)))),
      events: (await db.all('SELECT * FROM platform_events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 50', ws.id)).map((e) => ({ ...e, detail: parseJson(e.detail, {}) })),
    });
  });

  r.patch('/operator/workspaces/:id', async (req, res) => {
    const ws = await db.get('SELECT * FROM workspaces WHERE id = ?', req.params.id);
    if (!ws) throw notFound('Workspace');
    const body = parse(
      z.object({
        plan: z.enum(['free', 'standard', 'business']).optional(),
        paidThrough: z.string().datetime().nullable().optional(),
        trialEndsAt: z.string().datetime().nullable().optional(),
        suspended: z.boolean().optional(),
        reason: z.string().trim().max(300).optional(),
      }),
      req.body,
    );
    if (body.suspended && !body.reason) throw badRequest('Give a reason for suspending the workspace');
    await db.update('workspaces', ws.id, {
      plan: body.plan,
      paid_through: body.paidThrough,
      trial_ends_at: body.trialEndsAt,
      suspended_at: body.suspended === undefined ? undefined : body.suspended ? now() : null,
      suspended_reason: body.suspended === undefined ? undefined : body.suspended ? body.reason : null,
    });
    if (body.suspended) {
      for (const m of await db.all('SELECT user_id FROM memberships WHERE workspace_id = ?', ws.id)) ctx.hub.disconnect(ws.id, m.user_id);
      await db.run('DELETE FROM sessions WHERE workspace_id = ?', ws.id);
    }
    const detail = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    await platformEvent(ctx, await actor(req), body.suspended === undefined ? 'workspace.updated' : body.suspended ? 'workspace.suspended' : 'workspace.unsuspended', ws, detail);
    await audit(ctx, ws.id, null, 'operator.workspace_updated', 'workspace', ws.id, detail);
    res.json(await workspaceSummary((await db.get('SELECT * FROM workspaces WHERE id = ?', ws.id))!));
  });

  r.get('/operator/payments', async (req, res) => {
    const q = parse(z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() }), req.query);
    const rows = q.status
      ? await db.all('SELECT p.*, w.name AS workspace_name FROM payments p JOIN workspaces w ON w.id = p.workspace_id WHERE p.status = ? ORDER BY p.created_at DESC LIMIT 200', q.status)
      : await db.all('SELECT p.*, w.name AS workspace_name FROM payments p JOIN workspaces w ON w.id = p.workspace_id ORDER BY p.created_at DESC LIMIT 200');
    res.json((await Promise.all(rows.map(async (p) => ({ ...await paymentRow(db, p), workspace: { id: p.workspace_id, name: p.workspace_name } })))));
  });

  const loadPending = async (id: string) => {
    const p = await db.get(`SELECT * FROM payments WHERE id = ? AND status = 'pending'`, id);
    if (!p) throw notFound('Pending payment');
    return p;
  };

  r.post('/operator/payments/:id/approve', async (req, res) => {
    const p = await loadPending(String(req.params.id));
    const { note } = parse(z.object({ note: z.string().trim().max(300).default('') }), req.body);
    const ws = (await db.get('SELECT * FROM workspaces WHERE id = ?', p.workspace_id))!;
    // Renewing the same plan extends the current period; switching plans starts a new period today.
    const current = await effectivePlan(ctx, ws);
    const extending = ws.plan === p.plan && ws.paid_through && ws.paid_through > now() && current.status === 'active';
    const start = extending ? new Date(ws.paid_through) : new Date();
    const end = addMonths(start, p.months);
    await db.transaction(async () => {
      await db.run(
        `UPDATE payments SET status = 'approved', decided_by = ?, decided_at = ?, decision_note = ?, period_start = ?, period_end = ? WHERE id = ?`,
        (req.auth as Auth).userId,
        now(),
        note,
        start.toISOString(),
        end.toISOString(),
        p.id,
      );
      await db.update('workspaces', ws.id, { plan: p.plan as PlanId, paid_through: end.toISOString() });
      await platformEvent(ctx, await actor(req), 'payment.approved', ws, { payment: p.id, amount: p.amount, plan: p.plan, months: p.months, paid_through: end.toISOString() });
      await audit(ctx, ws.id, null, 'billing.payment_approved', 'payment', p.id, { plan: p.plan, paid_through: end.toISOString() });
    });
    const planName = planCatalog(ctx.config.billing)[p.plan as PlanId].name;
    await tellBillingContacts(
      ctx,
      ws.id,
      `Payment received — ${ws.name} is on ${planName}`,
      `We received your ${PAYMENT_METHODS[p.method as keyof typeof PAYMENT_METHODS] ?? p.method} payment of ${money(p.amount)} (reference ${p.reference}). ${ws.name} is on the ${planName} plan until ${end.toISOString().slice(0, 10)}.\n\nThank you for choosing SoftEX.`,
    );
    res.json(await paymentRow(db, (await db.get('SELECT * FROM payments WHERE id = ?', p.id))!));
  });

  r.post('/operator/payments/:id/reject', async (req, res) => {
    const p = await loadPending(String(req.params.id));
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    const ws = (await db.get('SELECT * FROM workspaces WHERE id = ?', p.workspace_id))!;
    await db.run(`UPDATE payments SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`, (req.auth as Auth).userId, now(), reason, p.id);
    await platformEvent(ctx, await actor(req), 'payment.rejected', ws, { payment: p.id, reason });
    await audit(ctx, ws.id, null, 'billing.payment_rejected', 'payment', p.id, { reason });
    await tellBillingContacts(
      ctx,
      ws.id,
      `We couldn't confirm your payment for ${ws.name}`,
      `We couldn't confirm the payment with reference ${p.reference} (${money(p.amount)}).\n\nReason: ${reason}\n\nIf you believe this is a mistake, reply with your payment receipt${ctx.config.billing.supportEmail ? ` to ${ctx.config.billing.supportEmail}` : ''}, or submit the payment again with the correct reference.`,
    );
    res.json(await paymentRow(db, (await db.get('SELECT * FROM payments WHERE id = ?', p.id))!));
  });

  r.get('/operator/events', async (_req, res) => {
    res.json((await db.all('SELECT * FROM platform_events ORDER BY created_at DESC LIMIT 200')).map((e) => ({ ...e, detail: parseJson(e.detail, {}) })));
  });

  // ---------- Backups ----------

  r.get('/operator/backups', async (_req, res) => {
    const supported = db.dialect === 'sqlite';
    res.json({
      supported,
      enabled: ctx.config.backups.enabled,
      location: backupLocation(ctx),
      every_hours: ctx.config.backups.everyHours,
      keep: ctx.config.backups.keep,
      last: await lastBackup(ctx),
      backups: supported ? await listBackups(ctx) : [],
    });
  });

  r.post('/operator/backups', async (req, res) => {
    if (db.dialect !== 'sqlite') throw badRequest('This server uses PostgreSQL. Use your database provider’s backups.');
    let backup;
    try {
      backup = await createBackup(ctx);
    } catch (error) {
      throw new HttpError(500, `The backup failed: ${(error as Error).message}`);
    }
    await platformEvent(ctx, await actor(req), 'backup.created', null, { name: backup.name, size: backup.size });
    res.status(201).json(backup);
  });

  // The whole database (every workspace), so downloads are logged.
  r.get('/operator/backups/:name/download', async (req, res) => {
    const name = String(req.params.name);
    const stream = await openBackup(ctx, name);
    if (!stream) throw notFound('Backup');
    await platformEvent(ctx, await actor(req), 'backup.downloaded', null, { name });
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    stream.on('error', (error) => {
      console.error('Backup download failed', error);
      res.destroy();
    });
    stream.pipe(res);
  });

  return r;
}

// ======================= Reminders about trials and renewals =======================

/** Tell owners and admins before a trial or paid period ends, and when a workspace moves to Free. Each notice is sent once. */
export async function processBillingNotices(ctx: Ctx, at = new Date()) {
  if (!isSaas(ctx)) return 0;
  const { db } = ctx;
  let sent = 0;
  const once = async (workspaceId: string, kind: string, ref: string) => {
    const res = await db.run('INSERT OR IGNORE INTO billing_notices (workspace_id, kind, ref, created_at) VALUES (?, ?, ?, ?)', workspaceId, kind, ref, now());
    return res.changes > 0;
  };
  const days = (iso: string) => (new Date(iso).getTime() - at.getTime()) / 86_400_000;
  for (const ws of await db.all('SELECT * FROM workspaces WHERE suspended_at IS NULL')) {
    const plan = await effectivePlan(ctx, ws, at);
    const notice = async (kind: string, ref: string, subject: string, text: string) => {
      if (await once(ws.id, kind, ref)) {
        await tellBillingContacts(ctx, ws.id, subject, text);
        sent += 1;
      }
    };
    if (plan.status === 'trial' && ws.trial_ends_at) {
      const left = days(ws.trial_ends_at);
      const end = ws.trial_ends_at.slice(0, 10);
      if (left <= 1) await notice('trial_1', ws.trial_ends_at, `Your SoftEX trial ends tomorrow`, `The Business trial for ${ws.name} ends on ${end}. Choose a plan to keep AI, automations, timelines and more. If you do nothing, ${ws.name} moves to the Free plan and nothing is deleted.`);
      else if (left <= 7) await notice('trial_7', ws.trial_ends_at, `Your SoftEX trial ends in ${Math.ceil(left)} days`, `The Business trial for ${ws.name} ends on ${end}. Choose a plan any time from Administration → Billing. If you do nothing, ${ws.name} moves to the Free plan and nothing is deleted.`);
    } else if (plan.status === 'active' && ws.paid_through) {
      const left = days(ws.paid_through);
      if (left <= 7) await notice('renew_7', ws.paid_through, `Time to renew SoftEX for ${ws.name}`, `${ws.name}'s ${plan.name} plan is paid until ${ws.paid_through.slice(0, 10)}. Renew from Administration → Billing to avoid interruption.`);
    } else if (plan.status === 'grace' && ws.paid_through) {
      await notice('overdue', ws.paid_through, `Payment overdue for ${ws.name}`, `${ws.name}'s ${plan.name} plan ended on ${ws.paid_through.slice(0, 10)}. Paid features keep working for ${GRACE_DAYS} days; after that the workspace moves to the Free plan. Nothing is deleted.`);
    } else if (plan.status === 'free') {
      const endedAt = [ws.trial_ends_at, ws.paid_through].filter((x): x is string => !!x && x < at.toISOString()).sort().pop();
      if (endedAt) await notice('moved_to_free', endedAt, `${ws.name} is now on the Free plan`, `${ws.name} has moved to the Free plan. Your data is safe. Paid features are paused until you choose a plan under Administration → Billing.`);
    }
  }
  return sent;
}
