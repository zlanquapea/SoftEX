import type { Ctx } from './context.js';
import type { Database, Row } from './db.js';
import { HttpError } from './util.js';

/**
 * Plans, trials and usage limits for hosted (SaaS) deployments.
 *
 * Self-hosted servers (the default) run everything without limits. With
 * SOFTEX_MODE=saas every workspace gets a plan:
 *
 * - Free: permanent, up to 10 members, core collaboration only.
 * - Standard: paid per member, adds planning, automations, guests, API and insights.
 * - Business: paid per member, adds AI, single sign-on, SCIM and retention controls.
 *
 * New workspaces start with a Business trial. When a trial or paid period ends
 * the workspace falls back to Free: nothing is deleted, but Free limits apply.
 */

export type PlanId = 'free' | 'standard' | 'business';
export type Feature = 'ai' | 'automations' | 'planning' | 'insights' | 'guests' | 'api' | 'sso' | 'scim' | 'retention';

export const FEATURE_LABEL: Record<Feature, string> = {
  ai: 'AI assistance',
  automations: 'Automations',
  planning: 'Timeline and workload',
  insights: 'Insights',
  guests: 'Guest access',
  api: 'API tokens and webhooks',
  sso: 'Single sign-on',
  scim: 'User provisioning (SCIM)',
  retention: 'Retention and legal hold',
};

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** Price per member per month in USD. */
  price: number;
  /** Maximum active members (guests count too); null means unlimited. */
  memberLimit: number | null;
  /** Storage allowance: a fixed base plus an amount per member, in bytes. */
  storageBase: number;
  storagePerMember: number;
  /** AI requests per member per month. */
  aiPerMember: number;
  features: Feature[];
  tagline: string;
}

const GB = 1024 ** 3;

export interface BillingConfig {
  priceStandard: number;
  priceBusiness: number;
  trialDays: number;
  /** AI requests a trial workspace may make in total, to limit abuse of free trials. */
  trialAiRequests: number;
  /** Discount multiplier for 12-month payments (e.g. 10/12 = two months free). */
  annualFactor: number;
  lrdPerUsd?: number;
  paymentInstructions: string;
  supportEmail?: string;
}

export function planCatalog(billing: BillingConfig): Record<PlanId, PlanDefinition> {
  return {
    free: {
      id: 'free',
      name: 'Free',
      price: 0,
      memberLimit: 10,
      storageBase: 2 * GB,
      storagePerMember: 0,
      aiPerMember: 0,
      features: [],
      tagline: 'For small teams getting started. Free forever.',
    },
    standard: {
      id: 'standard',
      name: 'Standard',
      price: billing.priceStandard,
      memberLimit: null,
      storageBase: 10 * GB,
      storagePerMember: 5 * GB,
      aiPerMember: 0,
      features: ['automations', 'planning', 'insights', 'guests', 'api'],
      tagline: 'For growing teams that plan and track work together.',
    },
    business: {
      id: 'business',
      name: 'Business',
      price: billing.priceBusiness,
      memberLimit: null,
      storageBase: 20 * GB,
      storagePerMember: 10 * GB,
      aiPerMember: 50,
      features: ['automations', 'planning', 'insights', 'guests', 'api', 'ai', 'sso', 'scim', 'retention'],
      tagline: 'For organisations that need AI, single sign-on and compliance controls.',
    },
  };
}

export type PlanStatus = 'self_hosted' | 'trial' | 'active' | 'grace' | 'free';

export interface EffectivePlan {
  id: PlanId | 'unlimited';
  name: string;
  status: PlanStatus;
  /** The plan the workspace pays for (or 'free'). */
  purchased: PlanId;
  trial_ends_at: string | null;
  paid_through: string | null;
  features: Feature[];
  member_limit: number | null;
  storage_limit: number | null;
  ai_limit: number | null;
}

/** Days after a paid period ends during which paid features keep working. */
export const GRACE_DAYS = 7;

const ALL_FEATURES = Object.keys(FEATURE_LABEL) as Feature[];

export const isSaas = (ctx: Ctx) => ctx.config.mode === 'saas';

/** People who run the service (SOFTEX_OPERATOR_EMAILS). Only meaningful in SaaS mode. */
export const isOperator = (ctx: Ctx, email: string | undefined) => isSaas(ctx) && !!email && ctx.config.operatorEmails.includes(email.toLowerCase());

export function activeMemberCount(db: Database, workspaceId: string) {
  return db.get(
    `SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND deactivated_at IS NULL
       AND (guest_expires_at IS NULL OR guest_expires_at > ?)`,
    workspaceId,
    new Date().toISOString(),
  )!.n as number;
}

/** Members who are billed: everyone active except guests. */
export function billableSeats(db: Database, workspaceId: string) {
  return Math.max(
    1,
    db.get(`SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND deactivated_at IS NULL AND role != 'guest'`, workspaceId)!.n as number,
  );
}

export function storageUsed(db: Database, workspaceId: string) {
  return (db.get(`SELECT COALESCE(SUM(v.size), 0) AS n FROM file_versions v JOIN files f ON f.id = v.file_id WHERE f.workspace_id = ?`, workspaceId)!.n ??
    0) as number;
}

export const monthStart = (at = new Date()) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();

export function aiUsedThisMonth(db: Database, workspaceId: string, since?: string) {
  return db.get('SELECT COUNT(*) AS n FROM ai_usage WHERE workspace_id = ? AND created_at >= ?', workspaceId, since ?? monthStart())!.n as number;
}

export function effectivePlan(ctx: Ctx, workspace: Row | string, at = new Date()): EffectivePlan {
  const ws = typeof workspace === 'string' ? ctx.db.get('SELECT * FROM workspaces WHERE id = ?', workspace)! : workspace;
  if (!isSaas(ctx)) {
    return {
      id: 'unlimited',
      name: 'Self-hosted',
      status: 'self_hosted',
      purchased: 'business',
      trial_ends_at: null,
      paid_through: null,
      features: ALL_FEATURES,
      member_limit: null,
      storage_limit: null,
      ai_limit: null,
    };
  }
  const catalog = planCatalog(ctx.config.billing);
  const purchased: PlanId = ws.plan in catalog && ws.plan !== 'free' ? ws.plan : 'free';
  const nowIso = at.toISOString();
  const graceEnd = ws.paid_through ? new Date(new Date(ws.paid_through).getTime() + GRACE_DAYS * 86_400_000).toISOString() : null;
  let status: PlanStatus = 'free';
  let id: PlanId = 'free';
  if (purchased !== 'free' && ws.paid_through && ws.paid_through > nowIso) {
    status = 'active';
    id = purchased;
  } else if (purchased !== 'free' && graceEnd && graceEnd > nowIso) {
    status = 'grace';
    id = purchased;
  } else if (ws.trial_ends_at && ws.trial_ends_at > nowIso) {
    status = 'trial';
    id = 'business';
  }
  const plan = catalog[id];
  const seats = billableSeats(ctx.db, ws.id);
  return {
    id,
    name: status === 'trial' ? `${plan.name} trial` : plan.name,
    status,
    purchased,
    trial_ends_at: ws.trial_ends_at ?? null,
    paid_through: ws.paid_through ?? null,
    features: plan.features,
    member_limit: plan.memberLimit,
    storage_limit: plan.storageBase + plan.storagePerMember * seats,
    ai_limit: status === 'trial' ? ctx.config.billing.trialAiRequests : plan.aiPerMember * seats,
  };
}

export function hasFeature(ctx: Ctx, workspaceId: string, feature: Feature) {
  return effectivePlan(ctx, workspaceId).features.includes(feature);
}

/** 402 Payment Required with a machine-readable code the web app turns into an upgrade prompt. */
export function planError(message: string, details: Record<string, unknown>) {
  return new HttpError(402, message, { code: 'plan_limit', ...details });
}

export function requireFeature(ctx: Ctx, workspaceId: string, feature: Feature) {
  const plan = effectivePlan(ctx, workspaceId);
  if (!plan.features.includes(feature)) {
    const needed = feature === 'ai' || feature === 'sso' || feature === 'scim' || feature === 'retention' ? 'Business' : 'Standard';
    throw planError(`${FEATURE_LABEL[feature]} is available on the ${needed} plan. An admin can upgrade under Administration → Billing.`, {
      feature,
      plan: plan.id,
    });
  }
}

/** Check there is room for `adding` more active members (and guest access when adding guests). */
export function requireMemberCapacity(ctx: Ctx, workspaceId: string, adding = 1, role?: string) {
  const plan = effectivePlan(ctx, workspaceId);
  if (role === 'guest' && !plan.features.includes('guests')) requireFeature(ctx, workspaceId, 'guests');
  if (plan.member_limit != null && activeMemberCount(ctx.db, workspaceId) + adding > plan.member_limit) {
    throw planError(`The ${plan.name} plan allows up to ${plan.member_limit} members. An admin can upgrade under Administration → Billing.`, {
      limit: 'members',
      plan: plan.id,
    });
  }
}

export function requireStorage(ctx: Ctx, workspaceId: string, bytes: number) {
  const plan = effectivePlan(ctx, workspaceId);
  if (plan.storage_limit != null && storageUsed(ctx.db, workspaceId) + bytes > plan.storage_limit) {
    throw planError('This workspace has used all of its file storage. Delete old files or upgrade under Administration → Billing.', {
      limit: 'storage',
      plan: plan.id,
    });
  }
}

export function requireAiQuota(ctx: Ctx, workspaceId: string) {
  const plan = effectivePlan(ctx, workspaceId);
  if (!plan.features.includes('ai')) requireFeature(ctx, workspaceId, 'ai');
  if (plan.ai_limit == null) return;
  const since = plan.status === 'trial' ? new Date(0).toISOString() : monthStart();
  if (aiUsedThisMonth(ctx.db, workspaceId, since) >= plan.ai_limit) {
    throw planError(
      plan.status === 'trial'
        ? 'This workspace has used all AI requests included in the trial. Choose a plan under Administration → Billing to continue.'
        : `This workspace has used its ${plan.ai_limit} AI requests for this month. The allowance resets on the 1st.`,
      { limit: 'ai', plan: plan.id },
    );
  }
}

/** On hosted servers, actions that reach other people or cost money need a verified email address. */
export function requireVerifiedEmail(ctx: Ctx, auth: { userId: string }) {
  if (!isSaas(ctx)) return;
  const user = ctx.db.get('SELECT email_verified_at FROM users WHERE id = ?', auth.userId);
  if (!user?.email_verified_at) {
    throw new HttpError(403, 'Please verify your email address first. Use the link we emailed you, or resend it from the banner at the top of the page.', {
      code: 'email_unverified',
    });
  }
}

/** Public, JSON-safe view of the catalog for the pricing page and billing screen. */
export function publicPlans(ctx: Ctx) {
  const catalog = planCatalog(ctx.config.billing);
  return (Object.values(catalog) as PlanDefinition[]).map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    member_limit: p.memberLimit,
    storage_base_gb: p.storageBase / GB,
    storage_per_member_gb: p.storagePerMember / GB,
    ai_per_member: p.aiPerMember,
    features: p.features,
    tagline: p.tagline,
  }));
}

/** Amount due for a payment covering `months` of `plan` for `seats` members. */
export function priceFor(ctx: Ctx, plan: PlanId, seats: number, months: number) {
  const unit = planCatalog(ctx.config.billing)[plan].price;
  const factor = months >= 12 ? ctx.config.billing.annualFactor : 1;
  return Math.round(unit * seats * months * factor * 100) / 100;
}
