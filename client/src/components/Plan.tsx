import { useEffect, useState, type ReactNode } from 'react';
import { allowanceBytes, bytes, dateLabel } from '../format';
import { Link } from 'react-router-dom';
import { api, type Feature, type PlanId, type PlanUsage, type PublicPlan } from '../api';
import { useApi } from '../hooks';
import { useSession } from '../session';
import { Sparkles } from 'lucide-react';
import { Icon } from './Icon';
import { Callout, Meter, useAction } from '@/components/kit';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const FEATURE_LABEL: Record<Feature, string> = {
  ai: 'AI assistance',
  automations: 'Automations',
  planning: 'Timeline and workload',
  insights: 'Insights and dashboards',
  guests: 'Guest access',
  api: 'API tokens and webhooks',
  sso: 'Single sign-on',
  scim: 'User provisioning (SCIM)',
  retention: 'Retention and legal hold',
  fields: 'Custom fields and time tracking',
  goals: 'Goals and intake forms',
  recordings: 'Meeting recordings and transcripts',
};

/** The plan catalog is the single source of truth for which plan unlocks a feature; fetched once per page load. */
let catalog: Promise<PublicPlan[]> | null = null;
const loadCatalog = () => (catalog ??= api.get<{ plans: PublicPlan[] }>('/public/plans').then((r) => r.plans).catch(() => ((catalog = null), [])));

/** The cheapest plan an admin can buy that includes a feature, e.g. "Team". */
export function useUpgradePlan(feature: Feature) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadCatalog().then((plans) => live && setName(plans.find((p) => p.self_serve && p.features.includes(feature))?.name ?? null));
    return () => {
      live = false;
    };
  }, [feature]);
  return name;
}

/** Plan helpers: which features this workspace has, and whether plans apply at all. */
export function usePlan() {
  const { me } = useSession();
  const plan = me?.workspace.plan;
  return {
    plan,
    saas: me?.mode === 'saas',
    has: (feature: Feature) => !plan || plan.features.includes(feature),
  };
}

export const daysUntil = (iso: string | null | undefined) => (iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)) : 0);

export const usd = (n: number) => `$${n.toFixed(n % 1 ? 2 : 0)}`;

/** Friendly Liberian-dollar equivalent when the operator has set an exchange rate. */
export const lrd = (n: number, rate: number | null | undefined) => (rate ? `≈ L$${Math.round(n * rate).toLocaleString()}` : '');

/**
 * Shown in place of a feature the workspace's plan doesn't include. With `readOnly`, it sits above
 * existing content that stays viewable after a downgrade.
 */
export function UpgradeNotice({ feature, compact = false, readOnly = false }: { feature: Feature; compact?: boolean; readOnly?: boolean }) {
  const { can } = useSession();
  const plan = useUpgradePlan(feature);
  return (
    <Alert role="note" className={cn('border-primary/20 bg-accent/60', compact && 'py-2.5')}>
      <Sparkles className="text-primary" />
      <AlertTitle>
        {readOnly ? `${FEATURE_LABEL[feature]} are read-only on your plan` : `${FEATURE_LABEL[feature]} is part of the ${plan ?? 'paid'} plan${plan ? '' : 's'}`}
      </AlertTitle>
      <AlertDescription>
        {readOnly
          ? `Everything already here stays readable. ${can('admin') ? `Upgrade${plan ? ` to ${plan}` : ''} to create and change them again.` : 'Ask a workspace admin to upgrade to make changes.'}`
          : can('admin')
            ? 'Upgrade to unlock it for your whole team. Nothing you already have changes.'
            : 'Ask a workspace admin to upgrade to unlock it.'}
      </AlertDescription>
      {can('admin') && (
        <AlertAction>
          <Link
            to="/admin?tab=billing"
            className={buttonVariants({
              size: "sm"
            })}>See plans
                      </Link>
        </AlertAction>
      )}
    </Alert>
  );
}

/** A full-width strip under the top bar. */
function Banner({ tone, children, action }: { tone: 'warning' | 'info'; children: ReactNode; action: ReactNode }) {
  return (
    <Callout tone={tone} className="rounded-none border-x-0 border-t-0" action={action}>
      {children}
    </Callout>
  );
}

/** Top-of-page reminders: confirm your email, trial countdown, overdue payment. */
export function AccountBanners() {
  const { me, can } = useSession();
  const act = useAction();
  const [sent, setSent] = useState(false);
  if (!me || me.mode !== 'saas') return null;
  const plan = me.workspace.plan;
  const banners = [];
  if (!me.user.email_verified) {
    banners.push(
      <Banner
        tone="warning"
        key="verify"
        action={
          <Button
            variant="outline"
            size="xs"
            disabled={sent}
            onClick={async () => {
              if (await act(() => api.post('/me/verify-email/resend'), 'Confirmation email sent')) setSent(true);
            }}
          >
            {sent ? 'Sent — check your inbox' : 'Resend link'}
          </Button>
        }
      >
        Please confirm your email address ({me.user.email}) to invite people, use AI and pay for a plan.
      </Banner>,
    );
  }
  if (can('admin')) {
    if (plan.status === 'trial' && daysUntil(plan.trial_ends_at) <= 14) {
      const days = daysUntil(plan.trial_ends_at);
      banners.push(
        <Banner
          tone="info"
          key="trial"
          action={
            <Link
              to="/admin?tab=billing"
              className={buttonVariants({
                variant: "outline",
                size: "xs"
              })}>See plans
                          </Link>
          }
        >
          {days <= 1 ? 'Your Organization trial ends today.' : `${days} days left in your Organization trial.`} Choose a plan to keep every feature.
        </Banner>,
      );
    }
    if (plan.status === 'grace') {
      banners.push(
        <Banner
          tone="warning"
          key="grace"
          action={
            <Link
              to="/admin?tab=billing"
              className={buttonVariants({
                variant: "outline",
                size: "xs"
              })}>Renew
                          </Link>
          }
        >
          Your {plan.name} plan ended on {dateLabel(plan.paid_through)}. Renew within a few days to keep paid features.
        </Banner>,
      );
    }
  }
  return <>{banners}</>;
}

/** A plan's price line: flat per workspace, free, or by quote. */
export function PlanPrice({ plan }: { plan: PublicPlan }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-1.5">
      {plan.price == null ? (
        <strong className="font-heading text-3xl font-semibold">Custom quote</strong>
      ) : plan.price ? (
        <>
          <strong className="font-heading text-3xl font-semibold">{usd(plan.price)}</strong> <span className="text-sm text-muted-foreground">per workspace / month</span>
        </>
      ) : (
        <>
          <strong className="font-heading text-3xl font-semibold">$0</strong> <span className="text-sm text-muted-foreground">per workspace</span>
        </>
      )}
    </p>
  );
}

/** Months free when paying for a year, e.g. 2 for a 10/12 factor. */
export const monthsFreeYearly = (annualFactor: number) => Math.round(12 * (1 - annualFactor));

/** "$250 billed yearly — 2 months free" (the whole year's charge, paid once). */
export function annualLine(plan: PublicPlan, annualFactor: number) {
  if (!plan.price) return null;
  const total = Math.round(plan.price * 12 * annualFactor * 100) / 100;
  const free = monthsFreeYearly(annualFactor);
  return `${usd(total)} billed yearly${free > 0 ? ` — ${free} month${free === 1 ? '' : 's'} free` : ''}`;
}

/** The most members any self-serve plan includes; Enterprise starts above it. */
export const largestTeam = (plans: PublicPlan[]) => Math.max(0, ...plans.filter((p) => p.self_serve && p.member_limit != null).map((p) => p.member_limit!));
export const memberAllowance = (plan: Pick<PublicPlan, 'member_limit'>) => (plan.member_limit == null ? 'Members by agreement' : `${plan.member_limit} members`);
export const projectAllowance = (plan: Pick<PublicPlan, 'project_limit'>) =>
  plan.project_limit == null ? 'Unlimited active projects' : `${plan.project_limit} active project${plan.project_limit === 1 ? '' : 's'}`;

/** The three numbers that differ most between plans: members, shared storage and active projects. */
export function PlanAllowances({ plan, className }: { plan: PublicPlan; className?: string }) {
  const rows: [string, string, string][] = [
    ['users', memberAllowance(plan), 'Guests don’t count'],
    ['folder', `${allowanceBytes(plan.storage_bytes)} storage`, 'Shared by the whole workspace'],
    ['board', projectAllowance(plan), 'Archived projects don’t count'],
  ];
  return (
    <ul className={cn('flex flex-col gap-2 rounded-xl bg-muted/50 p-3', className)} aria-label={`What ${plan.name} includes`}>
      {rows.map(([icon, main, hint]) => (
        <li key={main} className="flex items-start gap-2.5">
          <Icon name={icon} size={16} className="mt-0.5 shrink-0 text-primary" />
          <span className="flex flex-col">
            <strong className="text-sm font-semibold">{main}</strong>
            <span className="text-xs text-muted-foreground">{hint}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

const ORDER: PlanId[] = ['free', 'starter', 'team', 'organization', 'enterprise'];
const CORE = 'Projects, tasks, messaging, file sharing, knowledge and meetings';

const featureDetail = (plan: PublicPlan, f: Feature) =>
  f === 'recordings' ? (plan.recording_hours == null ? ' (unlimited)' : ` (${plan.recording_hours} hours a month)`) : f === 'ai' && plan.ai_per_month ? ` (${plan.ai_per_month.toLocaleString()} requests a month)` : '';

/** What upgrading to this plan adds over the one below it: only features that exist today. */
export function PlanUnlocks({ plan, plans }: { plan: PublicPlan; plans: PublicPlan[] }) {
  const sorted = [...plans].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  const previous = sorted[sorted.findIndex((p) => p.id === plan.id) - 1];
  const added = FEATURE_ORDER.filter((f) => plan.features.includes(f) && !previous?.features.includes(f));
  const support = plan.priority_support && !previous?.priority_support;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="font-medium">{previous ? `Everything in ${previous.name}, plus:` : 'Included:'}</p>
      <ul className="flex flex-col gap-1.5">
        {!previous && <FeatureRow>{CORE}</FeatureRow>}
        {previous && !added.length && !support && <FeatureRow>More members, storage and active projects</FeatureRow>}
        {added.map((f) => (
          <FeatureRow key={f}>
            {FEATURE_LABEL[f]}
            {featureDetail(plan, f)}
          </FeatureRow>
        ))}
        {support && <FeatureRow>Priority support</FeatureRow>}
      </ul>
    </div>
  );
}

function FeatureRow({ on = true, children }: { on?: boolean; children: ReactNode }) {
  return (
    <li className={cn('flex gap-2', !on && 'text-muted-foreground')}>
      <Icon name={on ? 'check' : 'x'} size={14} className={cn('mt-0.5 shrink-0', on ? 'text-success' : 'text-muted-foreground')} />
      <span>{children}</span>
    </li>
  );
}

/** Every plan side by side: allowances, then each feature. Scrolls sideways on small screens. */
export function PlanComparison({ plans }: { plans: PublicPlan[] }) {
  const sorted = [...plans].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  const rows: [string, (p: PublicPlan) => ReactNode][] = [
    ['Monthly price per workspace', (p) => (p.price == null ? 'Quote' : usd(p.price))],
    ['Members (guests don’t count)', (p) => (p.member_limit == null ? `${largestTeam(plans)}+` : p.member_limit)],
    ['Shared storage', (p) => allowanceBytes(p.storage_bytes)],
    ['Active projects', (p) => (p.project_limit == null ? 'Unlimited' : p.project_limit)],
    [CORE, () => <Icon name="check" size={16} className="mx-auto text-success" aria-label="Included" />],
    ...FEATURE_ORDER.map(
      (f) =>
        [
          FEATURE_LABEL[f],
          (p: PublicPlan) =>
            p.features.includes(f) ? (
              <span className="inline-flex items-center gap-1">
                <Icon name="check" size={16} className="text-success" aria-label="Included" />
                <span className="text-xs text-muted-foreground">{featureDetail(p, f).replace(/[()]/g, '').trim()}</span>
              </span>
            ) : (
              <span className="text-muted-foreground" aria-label="Not included">
                —
              </span>
            ),
        ] as [string, (p: PublicPlan) => ReactNode],
    ),
    ['Priority support', (p) => (p.priority_support ? <Icon name="check" size={16} className="mx-auto text-success" aria-label="Included" /> : <span className="text-muted-foreground" aria-label="Not included">—</span>)],
  ];
  return (
    // Focusable so keyboard users can scroll it sideways on a small screen.
    <div className="overflow-x-auto rounded-2xl border bg-card focus-visible:outline-2 focus-visible:outline-ring" tabIndex={0} role="region" aria-label="Plan comparison">
      <table className="w-full min-w-[40rem] text-sm">
        <caption className="sr-only">Compare plans</caption>
        <thead>
          <tr className="border-b">
            <th scope="col" className="p-3 text-left font-medium text-muted-foreground">
              Plan
            </th>
            {sorted.map((p) => (
              <th key={p.id} scope="col" className="p-3 text-center font-heading font-semibold">
                {p.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, cell], i) => (
            <tr key={label} className={cn('border-b last:border-0', i === 3 && 'border-b-2')}>
              <th scope="row" className="p-3 text-left font-normal">
                {label}
              </th>
              {sorted.map((p) => (
                <td key={p.id} className="p-3 text-center whitespace-nowrap tabular-nums">
                  {cell(p)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A stored amount: "320 KB", "212.4 MB", "5 GB". */
export const storageAmount = (n: number) => (n < 1024 ** 2 ? bytes(n) : allowanceBytes(n));

export interface UsageNumbers {
  members: number;
  member_limit: number | null;
  storage_bytes: number;
  storage_limit: number | null;
  projects: number;
  project_limit: number | null;
}

type Level = 'ok' | 'near' | 'full';
/** "near" from 80% of a limit, "full" at or over it. */
export const level = (used: number, limit: number | null): Level => (limit == null || limit <= 0 ? 'ok' : used >= limit ? 'full' : used / limit >= 0.8 ? 'near' : 'ok');

/** What each limit stops when it's reached, and how to get room again. */
const AT_LIMIT = {
  members: 'At the limit, new invitations wait. Deactivate people who no longer need access, or upgrade.',
  storage: 'At the limit, uploads stop. Delete files you no longer need, or upgrade. Nothing is deleted for you.',
  projects: 'At the limit, new projects wait. Archive finished projects (they stay readable), or upgrade.',
};

/** Members, shared storage and active projects against the plan's allowances, with a note near and at each limit. */
export function UsageMeters({ usage, guests }: { usage: UsageNumbers; guests?: number }) {
  const note = (key: keyof typeof AT_LIMIT, used: number, limit: number | null) => {
    const l = level(used, limit);
    return l === 'ok' ? undefined : (
      <span className={cn(l === 'full' ? 'text-destructive' : 'text-warning')}>
        {l === 'full' ? 'Limit reached. ' : 'Nearly full. '}
        {AT_LIMIT[key]}
      </span>
    );
  };
  return (
    <>
      <Meter
        label={guests ? `Members (plus ${guests} guest${guests === 1 ? '' : 's'}, who don't count)` : 'Members'}
        used={usage.members}
        limit={usage.member_limit}
        note={note('members', usage.members, usage.member_limit)}
      />
      <Meter label="Shared storage" used={usage.storage_bytes} limit={usage.storage_limit} format={storageAmount} note={note('storage', usage.storage_bytes, usage.storage_limit)} />
      <Meter label="Active projects" used={usage.projects} limit={usage.project_limit} note={note('projects', usage.projects, usage.project_limit)} />
    </>
  );
}

/** The workspace's shared allowances (members, storage, active projects); null on self-hosted servers, which have no limits. */
export function usePlanUsage() {
  const { me } = useSession();
  const { data, reload } = useApi<PlanUsage>(me?.mode === 'saas' ? '/plan/usage' : null);
  return { usage: data ?? null, reload };
}

const LIMIT_TEXT = {
  storage: {
    near: (u: PlanUsage) => `Storage is ${Math.round((u.storage_bytes / u.storage_limit!) * 100)}% full (${storageAmount(u.storage_bytes)} of ${allowanceBytes(u.storage_limit!)}, shared by the whole workspace).`,
    full: (u: PlanUsage) => `Storage is full (${storageAmount(u.storage_bytes)} of ${allowanceBytes(u.storage_limit!)}), so uploads are paused.`,
    fix: 'Delete files you no longer need to make room — everything else keeps working.',
  },
  projects: {
    near: (u: PlanUsage) => `${u.projects} of ${u.project_limit} active projects used on the ${u.plan.name} plan.`,
    full: (u: PlanUsage) => `All ${u.project_limit} active projects on the ${u.plan.name} plan are in use, so new projects are paused.`,
    fix: 'Archive a finished project to free a place — it stays readable and can be restored.',
  },
  members: {
    near: (u: PlanUsage) => `${u.members} of ${u.member_limit} members on the ${u.plan.name} plan (guests don't count).`,
    full: (u: PlanUsage) => `All ${u.member_limit} member places on the ${u.plan.name} plan are taken, so new invitations are paused.`,
    fix: 'Deactivate people who no longer need access to free a place.',
  },
} as const;

/**
 * A quiet note where a limit matters (Files for storage, Projects for active projects, invitations for members):
 * from 80% it warns, at the limit it says what's paused and how to make room. Nothing shows otherwise.
 */
export function LimitNotice({ kind, usage, className }: { kind: keyof typeof LIMIT_TEXT; usage: PlanUsage | null; className?: string }) {
  if (!usage) return null;
  const [used, limit] =
    kind === 'storage' ? [usage.storage_bytes, usage.storage_limit] : kind === 'projects' ? [usage.projects, usage.project_limit] : [usage.members, usage.member_limit];
  const l = level(used, limit);
  if (l === 'ok') return null;
  const text = LIMIT_TEXT[kind];
  return (
    <Callout
      tone={l === 'full' ? 'warning' : 'info'}
      className={className}
      action={
        <Link to={usage.can_manage_billing ? '/admin?tab=billing' : '/pricing'} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          {usage.can_manage_billing ? 'Upgrade' : 'See plans'}
        </Link>
      }
    >
      {l === 'full' ? text.full(usage) : text.near(usage)} {text.fix}
      {!usage.can_manage_billing && ' A workspace admin can upgrade for more.'}
    </Callout>
  );
}

/** How to get a plan that can't be bought in the app (Enterprise). */
export function contactHref(supportEmail: string | null | undefined, planName: string) {
  return supportEmail ? `mailto:${supportEmail}?subject=${encodeURIComponent(`Küü ${planName} quote`)}` : null;
}

export const FEATURE_ORDER: Feature[] = ['planning', 'fields', 'goals', 'recordings', 'automations', 'guests', 'insights', 'api', 'ai', 'sso', 'scim', 'retention'];
