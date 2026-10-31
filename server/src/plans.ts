import type { Ctx } from './context.js';
import type { Database, Row } from './db.js';
import { z } from 'zod';
import { HttpError, newId, now, parseJson } from './util.js';

/**
 * Plans, trials and usage limits for hosted (SaaS) deployments.
 *
 * Self-hosted servers (the default) run everything without limits. With
 * SOFTEX_MODE=saas every workspace gets a plan. Paid plans have a flat monthly
 * price per workspace, whatever the number of members up to the plan's limit:
 *
 * - Free: permanent, for trying Küü with a small team (3 members, 250 MB, 2 active projects).
 * - Starter: 6 members, 5 GB, 10 active projects; projects, tasks, messaging, file
 *   sharing, knowledge and meetings.
 * - Team: 15 members, 25 GB, unlimited projects; adds reporting, planning, custom fields,
 *   goals, automations, guests, API access and meeting recordings.
 * - Organization: 30 members, 100 GB, unlimited projects; adds AI, single sign-on, SCIM,
 *   retention controls and priority support.
 * - Enterprise: above 30 members, priced by quote and set up by the operator.
 *
 * Allowances are versioned (PLAN_VERSIONS). Each workspace records the version it signed
 * up under, so new packaging applies to new workspaces only and existing workspaces keep
 * their allowances until a migration is explicitly applied to them.
 *
 * New workspaces start with an Organization trial. When a trial or paid period
 * ends the workspace falls back to Free: nothing is deleted, but Free limits apply.
 * A workspace over a limit keeps full access to what it has (read, download, export,
 * archive, delete); only actions that would add more of that resource are refused.
 *
 * Enforcement follows the usual entitlements pattern:
 * - The plan catalog maps each plan to entitlements: feature flags and numeric limits.
 *   Code checks entitlements (`requireFeature(…, 'goals')`), never plan names.
 * - An operator can override entitlements for one workspace (custom deals, add-ons,
 *   comps); overrides sit on top of whatever plan the workspace is on.
 * - The server decides, on every request, from the workspace's billing state; the web
 *   app only mirrors the result to show upgrade prompts.
 * - A refusal is a 402 with a machine-readable reason, and is recorded as an upgrade
 *   signal. Admins are warned before a limit is reached.
 * - Downgrading never deletes data: premium content stays readable, but can't be
 *   created or changed until the workspace upgrades again.
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
  /** Maximum active full members, the owner included (guests don't count); null means unlimited. */
  memberLimit: number | null;
  /** File and recording storage shared by the whole workspace, in bytes. */
  storage: number;
  /** Projects that aren't archived; null means unlimited. */
  projectLimit: number | null;
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

/** Storage is measured in binary units throughout (1 GB = 1024 MB), matching how sizes are shown. */
export const MB = 1024 ** 2;
export const GB = 1024 ** 3;

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

/**
 * Plan packaging versions. A workspace keeps the version it was created under
 * (workspaces.plan_version) until a migration is explicitly applied to it.
 *
 * - v1: the original packaging (Free 5 members and 2 GB; no project limits). Every
 *   workspace created before 2026-11 is on it.
 * - 2026-11: Free is for evaluation (3 members, 250 MB, 2 active projects), paid plans
 *   have smaller member caps (6, 15 and 30) and clear storage and project allowances.
 *
 * Prices, features, AI and recording quotas, and Enterprise's negotiated terms are the same in both;
 * Enterprise starts above the largest self-serve plan's member cap.
 */
export const PLAN_VERSIONS = ['v1', '2026-11'] as const;
export type PlanVersion = (typeof PLAN_VERSIONS)[number];
/** The version new workspaces get. */
export const CURRENT_PLAN_VERSION: PlanVersion = '2026-11';
export const asPlanVersion = (v: unknown): PlanVersion => (PLAN_VERSIONS as readonly unknown[]).includes(v) ? (v as PlanVersion) : 'v1';

type Allowance = Pick<PlanDefinition, 'memberLimit' | 'storage' | 'projectLimit'>;
const ALLOWANCES: Record<PlanVersion, Record<PlanId, Allowance>> = {
  v1: {
    free: { memberLimit: 5, storage: 2 * GB, projectLimit: null },
    starter: { memberLimit: 10, storage: 20 * GB, projectLimit: null },
    team: { memberLimit: 25, storage: 100 * GB, projectLimit: null },
    organization: { memberLimit: 50, storage: 250 * GB, projectLimit: null },
    enterprise: { memberLimit: null, storage: 1024 * GB, projectLimit: null },
  },
  '2026-11': {
    free: { memberLimit: 3, storage: 250 * MB, projectLimit: 2 },
    starter: { memberLimit: 6, storage: 5 * GB, projectLimit: 10 },
    team: { memberLimit: 15, storage: 25 * GB, projectLimit: null },
    organization: { memberLimit: 30, storage: 100 * GB, projectLimit: null },
    // Enterprise terms are negotiated; unchanged from v1.
    enterprise: { memberLimit: null, storage: 1024 * GB, projectLimit: null },
  },
};

const TAGLINES: Record<PlanVersion, Record<PlanId, string>> = {
  v1: {
    free: 'For very small teams getting started.',
    starter: 'Projects, tasks, messaging and file sharing for small teams.',
    team: 'Everything in Starter, plus reporting, planning, automations and meeting recordings.',
    organization: 'Everything in Team, plus AI, advanced administration and priority support.',
    enterprise: 'For organisations above 50 members. Priced on usage, onboarding and support needs.',
  },
  '2026-11': {
    free: 'Try Küü with a small team.',
    starter: 'Run your team’s everyday work.',
    team: 'Coordinate projects, clients, and workflows.',
    organization: 'Manage growing teams with AI and advanced controls.',
    enterprise: 'For organisations above 30 members. Priced on usage, onboarding and support needs.',
  },
};

export function planCatalog(billing: BillingConfig, version: PlanVersion = CURRENT_PLAN_VERSION): Record<PlanId, PlanDefinition> {
  const a = ALLOWANCES[version];
  const t = TAGLINES[version];
  return {
    free: { id: 'free', name: 'Free', price: 0, ...a.free, aiPerMonth: 0, recordingHours: 0, prioritySupport: false, selfServe: false, features: [], tagline: t.free },
    starter: { id: 'starter', name: 'Starter', price: billing.priceStarter, ...a.starter, aiPerMonth: 0, recordingHours: 0, prioritySupport: false, selfServe: true, features: [], tagline: t.starter },
    team: { id: 'team', name: 'Team', price: billing.priceTeam, ...a.team, aiPerMonth: 0, recordingHours: 20, prioritySupport: false, selfServe: true, features: TEAM_FEATURES, tagline: t.team },
    organization: {
      id: 'organization',
      name: 'Organization',
      price: billing.priceOrganization,
      ...a.organization,
      aiPerMonth: 1000,
      recordingHours: 60,
      prioritySupport: true,
      selfServe: true,
      features: ORGANIZATION_FEATURES,
      tagline: t.organization,
    },
    enterprise: { id: 'enterprise', name: 'Enterprise', price: null, ...a.enterprise, aiPerMonth: 5000, recordingHours: null, prioritySupport: true, selfServe: false, features: ORGANIZATION_FEATURES, tagline: t.enterprise },
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
  /** Active (non-archived) projects; null means unlimited. */
  project_limit: number | null;
  /** The packaging version whose allowances apply to this workspace right now. */
  plan_version: PlanVersion | null;
  /** While a paid period bought under the original allowances runs: when it ends (the new allowances apply after). */
  legacy_until?: string | null;
  ai_limit: number | null;
  /** Hours of meeting recording per month; null means unlimited. */
  recording_hours: number | null;
  priority_support: boolean;
  /** Operator overrides apply to this workspace (a custom deal, add-on or comp). */
  custom: boolean;
}

/**
 * Per-workspace changes to what the plan includes. A missing key means "as the plan
 * says"; a limit of null means unlimited.
 */
export const EntitlementOverrides = z
  .object({
    grant: z.array(z.string()).max(20).default([]),
    revoke: z.array(z.string()).max(20).default([]),
    members: z.number().int().min(1).max(100_000).nullable().optional(),
    storage_gb: z.number().min(0.1).max(100_000).nullable().optional(),
    projects: z.number().int().min(1).max(100_000).nullable().optional(),
    ai_per_month: z.number().int().min(0).max(1_000_000).nullable().optional(),
    recording_hours: z.number().min(0).max(100_000).nullable().optional(),
    note: z.string().trim().max(300).default(''),
  })
  .strict();
export type EntitlementOverrides = z.infer<typeof EntitlementOverrides>;

const isFeature = (f: string): f is Feature => f in FEATURE_LABEL;

export function readOverrides(raw: string | null | undefined): EntitlementOverrides {
  const parsed = EntitlementOverrides.safeParse(parseJson(raw, {}));
  if (!parsed.success) return { grant: [], revoke: [], note: '' };
  return { ...parsed.data, grant: parsed.data.grant.filter(isFeature), revoke: parsed.data.revoke.filter(isFeature) };
}

const hasOverrides = (o: EntitlementOverrides) =>
  o.grant.length > 0 || o.revoke.length > 0 || ['members', 'storage_gb', 'projects', 'ai_per_month', 'recording_hours'].some((k) => k in o);

/** Days after a paid period ends during which paid features keep working. */
export const GRACE_DAYS = 7;

const ALL_FEATURES = Object.keys(FEATURE_LABEL) as Feature[];

export const isSaas = (ctx: Ctx) => ctx.config.mode === 'saas';

/** People who run the service (SOFTEX_OPERATOR_EMAILS). Only meaningful in SaaS mode. */
export const isOperator = (ctx: Ctx, email: string | undefined) => isSaas(ctx) && !!email && ctx.config.operatorEmails.includes(email.toLowerCase());

/** Active full members (the owner included) who count toward the plan's member limit. Guests don't. */
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

/**
 * Bytes stored for the whole workspace: every retained version of every uploaded file (archived files and
 * files in archived projects included) plus saved meeting recordings. Each stored object counts once.
 */
export async function storageUsed(db: Database, workspaceId: string) {
  const files = Number((await db.get(
    `SELECT COALESCE(SUM(size), 0) AS n FROM (SELECT v.storage_key, MAX(v.size) AS size FROM file_versions v JOIN files f ON f.id = v.file_id
       WHERE f.workspace_id = ? GROUP BY v.storage_key) stored`,
    workspaceId,
  ))!.n) || 0;
  const recordings = Number((await db.get('SELECT COALESCE(SUM(size), 0) AS n FROM meeting_recordings WHERE workspace_id = ? AND storage_key IS NOT NULL', workspaceId))!.n) || 0;
  return files + recordings;
}

/** Projects that count toward the plan's project limit: those not archived. */
export async function activeProjectCount(db: Database, workspaceId: string) {
  return Number((await db.get('SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ? AND archived_at IS NULL', workspaceId))!.n) || 0;
}

/**
 * Run `fn` holding the workspace's quota lock, so two requests can't both pass a limit check and then both
 * add. Check the limit again inside `fn`, then write. On PostgreSQL this locks the workspace row for the
 * transaction; SQLite transactions already run one at a time.
 */
export async function withQuotaLock<T>(ctx: Ctx, workspaceId: string, fn: () => Promise<T>): Promise<T> {
  return ctx.db.transaction(async () => {
    if (ctx.db.dialect === 'postgres') await ctx.db.get('SELECT id FROM workspaces WHERE id = ? FOR UPDATE', workspaceId);
    return fn();
  });
}

/** "250 MB", "5 GB", "1.5 GB": the same binary units the plan allowances use. */
export function formatBytes(bytes: number) {
  if (bytes >= GB) return `${Math.round((bytes / GB) * 10) / 10} GB`;
  if (bytes >= MB) return `${Math.round((bytes / MB) * 10) / 10} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
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
      project_limit: null,
      plan_version: null,
      ai_limit: null,
      recording_hours: null,
      priority_support: false,
      custom: false,
    };
  }
  const version = asPlanVersion(ws.plan_version);
  const catalog = planCatalog(ctx.config.billing, version);
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
  // A paid period bought under the original allowances keeps them until that period (and its grace) ends.
  const legacyUntil = version !== 'v1' && ws.legacy_allowances_until && (status === 'active' || status === 'grace')
    ? new Date(new Date(ws.legacy_allowances_until).getTime() + GRACE_DAYS * 86_400_000) > at ? (ws.legacy_allowances_until as string) : null
    : null;
  const applied: PlanVersion = legacyUntil ? 'v1' : version;
  const plan = planCatalog(ctx.config.billing, applied)[id];
  const o = readOverrides(ws.entitlement_overrides);
  const features = ALL_FEATURES.filter((f) => (plan.features.includes(f) || o.grant.includes(f)) && !o.revoke.includes(f));
  const pick = <T>(key: keyof EntitlementOverrides, fallback: T, map: (v: number) => T = (v) => v as T): T =>
    key in o && o[key] !== undefined ? (o[key] === null ? (null as T) : map(o[key] as number)) : fallback;
  return {
    id,
    name: status === 'trial' ? `${plan.name} trial` : plan.name,
    status,
    purchased,
    trial_ends_at: ws.trial_ends_at ?? null,
    paid_through: ws.paid_through ?? null,
    features,
    member_limit: pick('members', plan.memberLimit),
    storage_limit: pick('storage_gb', plan.storage as number | null, (gb) => Math.round(gb * GB)),
    project_limit: pick('projects', plan.projectLimit),
    plan_version: applied,
    legacy_until: legacyUntil,
    ai_limit: pick('ai_per_month', status === 'trial' ? ctx.config.billing.trialAiRequests : plan.aiPerMonth as number | null),
    recording_hours: pick('recording_hours', plan.recordingHours),
    priority_support: plan.prioritySupport,
    custom: hasOverrides(o),
  };
}

/** Remember that the plan stopped someone. These are the clearest signals of what a workspace would pay for. */
export async function recordDenial(ctx: Ctx, workspaceId: string, key: string) {
  try {
    await ctx.db.insert('plan_denials', { id: newId(), workspace_id: workspaceId, key, created_at: now() });
  } catch (error) {
    console.error('Could not record a plan denial', error);
  }
}

/** Denials since a date, most frequent first: [{ key, count }]. */
export async function planDenials(db: Database, workspaceId: string, since: string) {
  return (await db.all(
    `SELECT key, COUNT(*) AS count FROM plan_denials WHERE workspace_id = ? AND created_at >= ? GROUP BY key ORDER BY count DESC, key`,
    workspaceId,
    since,
  )).map((r) => ({ key: String(r.key), count: Number(r.count) }));
}

/** A readable name for a denial key: a feature, or one of the limits. */
export const denialLabel = (key: string) =>
  isFeature(key)
    ? FEATURE_LABEL[key]
    : ({ 'limit:members': 'Adding members', 'limit:storage': 'Uploading files', 'limit:projects': 'Creating projects', 'limit:ai': 'AI requests', 'limit:recordings': 'Recording meetings' } as Record<string, string>)[key] ?? key;

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
    await recordDenial(ctx, workspaceId, feature);
    throw planError(`${FEATURE_LABEL[feature]} is available on the ${needed} plan. An admin can upgrade under Administration → Billing.`, {
      feature,
      plan: plan.id,
    });
  }
}

/** The next self-serve plan (for this workspace's packaging) that raises a limit above `needed`, for error messages. */
function upgradeFor(ctx: Ctx, version: PlanVersion, limit: 'memberLimit' | 'storage' | 'projectLimit', needed: number) {
  return Object.values(planCatalog(ctx.config.billing, version)).find((p) => p.selfServe && (p[limit] == null || (p[limit] as number) >= needed));
}

const nextStep = (plan: EffectivePlan, upgrade: PlanDefinition | undefined) =>
  upgrade && upgrade.id !== plan.id ? `The ${upgrade.name} plan includes more. An admin can upgrade under Administration → Billing.` : 'Contact us about Enterprise for more.';

/**
 * Check there is room for `adding` more full members. Guests don't count, but need guest access on the plan.
 * Call it again inside withQuotaLock right before the write when requests may race.
 */
export async function requireMemberCapacity(ctx: Ctx, workspaceId: string, adding = 1, role?: string) {
  const plan = await effectivePlan(ctx, workspaceId);
  if (role === 'guest') {
    if (!plan.features.includes('guests')) await requireFeature(ctx, workspaceId, 'guests');
    return;
  }
  if (plan.member_limit == null || adding <= 0) return;
  const members = await activeMemberCount(ctx.db, workspaceId);
  if (members + adding > plan.member_limit) {
    await recordDenial(ctx, workspaceId, 'limit:members');
    const upgrade = upgradeFor(ctx, plan.plan_version ?? CURRENT_PLAN_VERSION, 'memberLimit', members + adding);
    throw planError(
      `The ${plan.name} plan includes ${plan.member_limit} members (guests don't count), and this workspace has ${members}. Deactivate someone who no longer needs access, or upgrade. ${nextStep(plan, upgrade)}`,
      { limit: 'members', plan: plan.id, used: members, allowed: plan.member_limit, upgrade: upgrade?.id ?? null },
    );
  }
}

/** Check there is room for `adding` more active projects. Archived projects don't count. */
export async function requireProjectCapacity(ctx: Ctx, workspaceId: string, adding = 1) {
  const plan = await effectivePlan(ctx, workspaceId);
  if (plan.project_limit == null) return;
  const active = await activeProjectCount(ctx.db, workspaceId);
  if (active + adding > plan.project_limit) {
    await recordDenial(ctx, workspaceId, 'limit:projects');
    const upgrade = upgradeFor(ctx, plan.plan_version ?? CURRENT_PLAN_VERSION, 'projectLimit', active + adding);
    throw planError(
      `The ${plan.name} plan includes ${plan.project_limit} active project${plan.project_limit === 1 ? '' : 's'}, and this workspace has ${active}. Archive a finished project (its tasks and files stay available), or upgrade. ${nextStep(plan, upgrade)}`,
      { limit: 'projects', plan: plan.id, used: active, allowed: plan.project_limit, upgrade: upgrade?.id ?? null },
    );
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
    await recordDenial(ctx, workspaceId, 'limit:recordings');
    throw planError(
      `This workspace has used its ${plan.recording_hours} hours of meeting recording for this month. The allowance resets on the 1st, or an admin can upgrade under Administration → Billing.`,
      { limit: 'recordings', plan: plan.id },
    );
  }
}

/**
 * Check `bytes` more fit in the workspace's shared storage. Uploads check before processing (to fail fast) and
 * again inside withQuotaLock just before saving, so simultaneous uploads can't overshoot.
 */
export async function requireStorage(ctx: Ctx, workspaceId: string, bytes: number) {
  const plan = await effectivePlan(ctx, workspaceId);
  if (plan.storage_limit == null) return;
  const used = await storageUsed(ctx.db, workspaceId);
  if (used + bytes > plan.storage_limit) {
    await recordDenial(ctx, workspaceId, 'limit:storage');
    const full = used >= plan.storage_limit;
    const upgrade = upgradeFor(ctx, plan.plan_version ?? CURRENT_PLAN_VERSION, 'storage', used + bytes);
    throw planError(
      `${full ? 'This workspace has used all of its' : 'This file doesn’t fit in the workspace’s remaining'} storage (${formatBytes(used)} of ${formatBytes(plan.storage_limit)} on the ${plan.name} plan). Delete files you no longer need, or upgrade. ${nextStep(plan, upgrade)}`,
      { limit: 'storage', plan: plan.id, used, allowed: plan.storage_limit, upgrade: upgrade?.id ?? null },
    );
  }
}

export async function requireAiQuota(ctx: Ctx, workspaceId: string) {
  const plan = await effectivePlan(ctx, workspaceId);
  if (!plan.features.includes('ai')) await requireFeature(ctx, workspaceId, 'ai');
  if (plan.ai_limit == null) return;
  const since = plan.status === 'trial' ? new Date(0).toISOString() : monthStart();
  if (await aiUsedThisMonth(ctx.db, workspaceId, since) >= plan.ai_limit) {
    await recordDenial(ctx, workspaceId, 'limit:ai');
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

/**
 * Public, JSON-safe view of the catalog: the one source for the pricing page, billing screen, onboarding and
 * upgrade prompts. Defaults to the packaging new workspaces get; the billing screen passes the workspace's own.
 */
export function publicPlans(ctx: Ctx, version: PlanVersion = CURRENT_PLAN_VERSION) {
  const catalog = planCatalog(ctx.config.billing, version);
  return (Object.values(catalog) as PlanDefinition[]).map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    member_limit: p.memberLimit,
    storage_bytes: p.storage,
    /** Kept for older clients (the phone app); prefer storage_bytes. Not rounded, so 250 MB is 0.244. */
    storage_gb: p.storage / GB,
    project_limit: p.projectLimit,
    ai_per_month: p.aiPerMonth,
    recording_hours: p.recordingHours,
    priority_support: p.prioritySupport,
    self_serve: p.selfServe,
    features: p.features,
    tagline: p.tagline,
  }));
}

/** Amount due for a payment covering `months` of a self-serve plan (a flat price per workspace). */
export function priceFor(ctx: Ctx, plan: PlanId, months: number, version: PlanVersion = CURRENT_PLAN_VERSION) {
  const unit = planCatalog(ctx.config.billing, version)[plan].price ?? 0;
  const factor = months >= 12 ? ctx.config.billing.annualFactor : 1;
  return Math.round(unit * months * factor * 100) / 100;
}
