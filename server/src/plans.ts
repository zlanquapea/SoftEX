import type { Ctx } from './context.js';
import type { Database, Row } from './db.js';
import { HttpError } from './util.js';

/**
 * Plans, trials and usage limits for hosted (SaaS) deployments.
 *
 * Self-hosted servers (the default) run everything without limits. With
 * SOFTEX_MODE=saas every workspace gets a plan. Paid plans have a flat monthly
 * price per workspace, whatever the number of members up to the plan's limit:
 *
 * - Free: permanent, up to 5 members, core collaboration only.
 * - Starter: up to 10 members; projects, tasks, messaging and file sharing.
 * - Team: up to 25 members; adds reporting, planning, automations, guests, API,
 *   meeting recordings, and more storage.
 * - Organization: up to 50 members; adds AI, single sign-on, SCIM, retention
 *   controls and priority support.
 * - Enterprise: above 50 members, priced by quote and set up by the operator.
 *
 * New workspaces start with an Organization trial. When a trial or paid period
 * ends the workspace falls back to Free: nothing is deleted, but Free limits apply.
 */

/** Bump when the terms of service or privacy policy change materially; recorded on each acceptance. */
export const TERMS_VERSION = '2026-09-29';

export type PlanId = 'free' | 'starter' | 'team' | 'organization' | 'enterprise';
/** Plans a workspace admin can pay for themselves; Enterprise is arranged with the operator. */
export const SELF_SERVE_PLANS = ['starter', 'team', 'organization'] as const;
export type Feature = 'ai' | 'automations' | 'planning' | 'fields' | 'goals' | 'recordings' | 'insights' | 'guests' | 'api' | 'sso' | 'scim' | 'retention';

export const FEATURE_LABEL: Record<Feature, string> = {
  ai: 'AI assistance',
  automations: 'Automations',
  planning: 'Timeline and workload',
  fields: 'Custom fields and time tracking',
  goals: 'Goals and intake forms',
  insights: 'Insights and dashboards',
  recordings: 'Meeting recordings and transcripts',
  guests: 'Guest access',
  api: 'API tokens and webhooks',
  sso: 'Single sign-on',
  scim: 'User provisioning (SCIM)',
  retention: 'Retention and legal hold',
};

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** Price per workspace per month in USD; null means priced by quote. */
  price: number | null;
  /** Maximum active members (guests count too); null means unlimited. */
  memberLimit: number | null;
  /** File and recording storage for the whole workspace, in bytes. */
  storage: number;
  /** AI requests per month for the whole workspace. */
  aiPerMonth: number;
  /** Hours of meeting recording per month; null means unlimited. */
  recordingHours: number | null;
  prioritySupport: boolean;
  /** Can a workspace admin pay for it from the billing screen? */
  selfServe: boolean;
  features: Feature[];
  tagline: string;
}

const GB = 1024 ** 3;

export interface BillingConfig {
  priceStarter: number;
  priceTeam: number;
  priceOrganization: number;
  trialDays: number;
  /** AI requests a trial workspace may make in total, to limit abuse of free trials. */
  trialAiRequests: number;
  /** Discount multiplier for 12-month payments (e.g. 10/12 = two months free). */
  annualFactor: number;
  lrdPerUsd?: number;
  paymentInstructions: string;
  supportEmail?: string;
}

const TEAM_FEATURES: Feature[] = ['automations', 'planning', 'fields', 'goals', 'recordings', 'insights', 'guests', 'api'];
const ORGANIZATION_FEATURES: Feature[] = [...TEAM_FEATURES, 'ai', 'sso', 'scim', 'retention'];

export function planCatalog(billing: BillingConfig): Record<PlanId, PlanDefinition> {
  return {
    free: {
      id: 'free',
      name: 'Free',
      price: 0,
      memberLimit: 5,
      storage: 2 * GB,
      aiPerMonth: 0,
      recordingHours: 0,
      prioritySupport: false,
      selfServe: false,
      features: [],
      tagline: 'For very small teams getting started.',
    },
    starter: {
      id: 'starter',
      name: 'Starter',
      price: billing.priceStarter,
      memberLimit: 10,
      storage: 20 * GB,
      aiPerMonth: 0,
      recordingHours: 0,
      prioritySupport: false,
      selfServe: true,
      features: [],
      tagline: 'Projects, tasks, messaging and file sharing for small teams.',
    },
    team: {
      id: 'team',
      name: 'Team',
      price: billing.priceTeam,
      memberLimit: 25,
      storage: 100 * GB,
      aiPerMonth: 0,
      recordingHours: 20,
      prioritySupport: false,
      selfServe: true,
      features: TEAM_FEATURES,
      tagline: 'Everything in Starter, plus reporting, planning, automations and meeting recordings.',
    },
    organization: {
      id: 'organization',
      name: 'Organization',
      price: billing.priceOrganization,
      memberLimit: 50,
      storage: 250 * GB,
      aiPerMonth: 1000,
      recordingHours: 60,
      prioritySupport: true,
      selfServe: true,
      features: ORGANIZATION_FEATURES,
      tagline: 'Everything in Team, plus AI, advanced administration and priority support.',
    },
    enterprise: {
      id: 'enterprise',
      name: 'Enterprise',
      price: null,
      memberLimit: null,
      storage: 1024 * GB,
      aiPerMonth: 5000,
      recordingHours: null,
      prioritySupport: true,
      selfServe: false,
      features: ORGANIZATION_FEATURES,
      tagline: 'For organisations above 50 members. Priced on usage, onboarding and support needs.',
    },
  };
}

/** The cheapest plan that includes a feature, for upgrade messages. */
export function planWith(billing: BillingConfig, feature: Feature) {
  return Object.values(planCatalog(billing)).find((p) => p.selfServe && p.features.includes(feature))?.name ?? 'Organization';
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
  /** Hours of meeting recording per month; null means unlimited. */
  recording_hours: number | null;
  priority_support: boolean;
}

/** Days after a paid period ends during which paid features keep working. */
export const GRACE_DAYS = 7;

const ALL_FEATURES = Object.keys(FEATURE_LABEL) as Feature[];

export const isSaas = (ctx: Ctx) => ctx.config.mode === 'saas';

/** People who run the service (SOFTEX_OPERATOR_EMAILS). Only meaningful in SaaS mode. */
export const isOperator = (ctx: Ctx, email: string | undefined) => isSaas(ctx) && !!email && ctx.config.operatorEmails.includes(email.toLowerCase());

/** Active members who count toward the plan's member limit. Guests don't. */
export async function activeMemberCount(db: Database, workspaceId: string) {
  return (await db.get(`SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND deactivated_at IS NULL AND role != 'guest'`, workspaceId))!.n as number;
}

/** Guests whose access hasn't expired. */
export async function activeGuestCount(db: Database, workspaceId: string) {
  return (await db.get(
    `SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND deactivated_at IS NULL AND role = 'guest'
       AND (guest_expires_at IS NULL OR guest_expires_at > ?)`,
    workspaceId,
    new Date().toISOString(),
  ))!.n as number;
}

export async function storageUsed(db: Database, workspaceId: string) {
  const files = Number((await db.get(`SELECT COALESCE(SUM(v.size), 0) AS n FROM file_versions v JOIN files f ON f.id = v.file_id WHERE f.workspace_id = ?`, workspaceId))!.n) || 0;
  const recordings = Number((await db.get('SELECT COALESCE(SUM(size), 0) AS n FROM meeting_recordings WHERE workspace_id = ?', workspaceId))!.n) || 0;
  return files + recordings;
}

export const monthStart = (at = new Date()) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();

export async function aiUsedThisMonth(db: Database, workspaceId: string, since?: string) {
  return (await db.get('SELECT COUNT(*) AS n FROM ai_usage WHERE workspace_id = ? AND created_at >= ?', workspaceId, since ?? monthStart()))!.n as number;
}

export async function effectivePlan(ctx: Ctx, workspace: Row | string, at = new Date()): Promise<EffectivePlan> {
  const ws = typeof workspace === 'string' ? (await ctx.db.get('SELECT * FROM workspaces WHERE id = ?', workspace))! : workspace;
  if (!isSaas(ctx)) {
    return {
      id: 'unlimited',
      name: 'Self-hosted',
      status: 'self_hosted',
      purchased: 'enterprise',
      trial_ends_at: null,
      paid_through: null,
      features: ALL_FEATURES,
      member_limit: null,
      storage_limit: null,
      ai_limit: null,
      recording_hours: null,
      priority_support: false,
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
    id = 'organization';
  }
  const plan = catalog[id];
  return {
    id,
    name: status === 'trial' ? `${plan.name} trial` : plan.name,
    status,
    purchased,
    trial_ends_at: ws.trial_ends_at ?? null,
    paid_through: ws.paid_through ?? null,
    features: plan.features,
    member_limit: plan.memberLimit,
    storage_limit: plan.storage,
    ai_limit: status === 'trial' ? ctx.config.billing.trialAiRequests : plan.aiPerMonth,
    recording_hours: plan.recordingHours,
    priority_support: plan.prioritySupport,
  };
}

export async function hasFeature(ctx: Ctx, workspaceId: string, feature: Feature) {
  return (await effectivePlan(ctx, workspaceId)).features.includes(feature);
}

/** 402 Payment Required with a machine-readable code the web app turns into an upgrade prompt. */
export function planError(message: string, details: Record<string, unknown>) {
  return new HttpError(402, message, { code: 'plan_limit', ...details });
}

export async function requireFeature(ctx: Ctx, workspaceId: string, feature: Feature) {
  const plan = await effectivePlan(ctx, workspaceId);
  if (!plan.features.includes(feature)) {
    const needed = planWith(ctx.config.billing, feature);
    throw planError(`${FEATURE_LABEL[feature]} is available on the ${needed} plan. An admin can upgrade under Administration → Billing.`, {
      feature,
      plan: plan.id,
    });
  }
}

/** Check there is room for `adding` more members, or that guest access is included when adding guests (who don't count toward the limit). */
export async function requireMemberCapacity(ctx: Ctx, workspaceId: string, adding = 1, role?: string) {
  const plan = await effectivePlan(ctx, workspaceId);
  if (role === 'guest') {
    if (!plan.features.includes('guests')) await requireFeature(ctx, workspaceId, 'guests');
    return;
  }
  if (plan.member_limit != null && await activeMemberCount(ctx.db, workspaceId) + adding > plan.member_limit) {
    throw planError(`The ${plan.name} plan allows up to ${plan.member_limit} members. An admin can upgrade under Administration → Billing.`, {
      limit: 'members',
      plan: plan.id,
    });
  }
}

/** Seconds of meeting recording made this month. */
export async function recordingSecondsThisMonth(db: Database, workspaceId: string) {
  return Number((await db.get('SELECT COALESCE(SUM(duration_sec), 0) AS n FROM meeting_recordings WHERE workspace_id = ? AND started_at >= ?', workspaceId, monthStart()))!.n) || 0;
}

/** Check the workspace has recording hours left this month. */
export async function requireRecordingAllowance(ctx: Ctx, workspaceId: string) {
  const plan = await effectivePlan(ctx, workspaceId);
  if (plan.recording_hours == null) return;
  if (await recordingSecondsThisMonth(ctx.db, workspaceId) >= plan.recording_hours * 3600) {
    throw planError(
      `This workspace has used its ${plan.recording_hours} hours of meeting recording for this month. The allowance resets on the 1st, or an admin can upgrade under Administration → Billing.`,
      { limit: 'recordings', plan: plan.id },
    );
  }
}

export async function requireStorage(ctx: Ctx, workspaceId: string, bytes: number) {
  const plan = await effectivePlan(ctx, workspaceId);
  if (plan.storage_limit != null && await storageUsed(ctx.db, workspaceId) + bytes > plan.storage_limit) {
    throw planError('This workspace has used all of its file storage. Delete old files or upgrade under Administration → Billing.', {
      limit: 'storage',
      plan: plan.id,
    });
  }
}

export async function requireAiQuota(ctx: Ctx, workspaceId: string) {
  const plan = await effectivePlan(ctx, workspaceId);
  if (!plan.features.includes('ai')) await requireFeature(ctx, workspaceId, 'ai');
  if (plan.ai_limit == null) return;
  const since = plan.status === 'trial' ? new Date(0).toISOString() : monthStart();
  if (await aiUsedThisMonth(ctx.db, workspaceId, since) >= plan.ai_limit) {
    throw planError(
      plan.status === 'trial'
        ? 'This workspace has used all AI requests included in the trial. Choose a plan under Administration → Billing to continue.'
        : `This workspace has used its ${plan.ai_limit} AI requests for this month. The allowance resets on the 1st.`,
      { limit: 'ai', plan: plan.id },
    );
  }
}

/** On hosted servers, actions that reach other people or cost money need a verified email address. */
export async function requireVerifiedEmail(ctx: Ctx, auth: { userId: string }) {
  if (!isSaas(ctx)) return;
  const user = await ctx.db.get('SELECT email_verified_at FROM users WHERE id = ?', auth.userId);
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
    storage_gb: p.storage / GB,
    ai_per_month: p.aiPerMonth,
    recording_hours: p.recordingHours,
    priority_support: p.prioritySupport,
    self_serve: p.selfServe,
    features: p.features,
    tagline: p.tagline,
  }));
}

/** Amount due for a payment covering `months` of a self-serve plan (a flat price per workspace). */
export function priceFor(ctx: Ctx, plan: PlanId, months: number) {
  const unit = planCatalog(ctx.config.billing)[plan].price ?? 0;
  const factor = months >= 12 ? ctx.config.billing.annualFactor : 1;
  return Math.round(unit * months * factor * 100) / 100;
}
