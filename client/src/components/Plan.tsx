import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Feature, type PublicPlan } from '../api';
import { useSession } from '../session';
import { Icon } from './Icon';
import { useAction } from './ui';

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

const ORGANIZATION_ONLY: Feature[] = ['ai', 'sso', 'scim', 'retention'];

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

/** Shown in place of a feature the workspace's plan doesn't include. */
export function UpgradeNotice({ feature, compact = false }: { feature: Feature; compact?: boolean }) {
  const { can } = useSession();
  const plan = ORGANIZATION_ONLY.includes(feature) ? 'Organization' : 'Team';
  return (
    <div className={`upgrade-notice ${compact ? 'compact' : ''}`} role="note">
      <span className="upgrade-icon">
        <Icon name="spark" size={compact ? 16 : 22} />
      </span>
      <div className="grow">
        <strong>{FEATURE_LABEL[feature]} is part of the {plan} plan</strong>
        <p className="muted">
          {can('admin') ? 'Upgrade to unlock it for your whole team. Nothing you already have changes.' : 'Ask a workspace admin to upgrade to unlock it.'}
        </p>
      </div>
      {can('admin') && (
        <Link className="btn primary sm" to="/admin?tab=billing">
          See plans
        </Link>
      )}
    </div>
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
      <div className="banner warn" key="verify">
        <Icon name="alert" size={15} /> Please confirm your email address ({me.user.email}) to invite people, use AI and pay for a plan.
        <button
          className="link-btn"
          disabled={sent}
          onClick={async () => {
            if (await act(() => api.post('/me/verify-email/resend'), 'Confirmation email sent')) setSent(true);
          }}
        >
          {sent ? 'Sent — check your inbox' : 'Resend link'}
        </button>
      </div>,
    );
  }
  if (can('admin')) {
    if (plan.status === 'trial' && daysUntil(plan.trial_ends_at) <= 14) {
      const days = daysUntil(plan.trial_ends_at);
      banners.push(
        <div className="banner" key="trial">
          <Icon name="clock" size={15} /> {days <= 1 ? 'Your Organization trial ends today.' : `${days} days left in your Organization trial.`} Choose a plan to keep every feature.
          <Link to="/admin?tab=billing">See plans</Link>
        </div>,
      );
    }
    if (plan.status === 'grace') {
      banners.push(
        <div className="banner warn" key="grace">
          <Icon name="alert" size={15} /> Your {plan.name} plan ended on {plan.paid_through?.slice(0, 10)}. Renew within a few days to keep paid features.
          <Link to="/admin?tab=billing">Renew</Link>
        </div>,
      );
    }
  }
  return <>{banners}</>;
}

const storage = (gb: number) => (gb >= 1024 ? `${gb / 1024} TB` : `${gb} GB`);

/** A plan's price line: flat per workspace, free, or by quote. */
export function PlanPrice({ plan }: { plan: PublicPlan }) {
  return (
    <p className="plan-price">
      {plan.price == null ? (
        <strong>Custom quote</strong>
      ) : plan.price ? (
        <>
          <strong>{usd(plan.price)}</strong> <span className="muted">per workspace / month</span>
        </>
      ) : (
        <>
          <strong>$0</strong> <span className="muted">forever</span>
        </>
      )}
    </p>
  );
}

export function PlanFeatures({ plan, all }: { plan: PublicPlan; all: Feature[] }) {
  const has = (f: Feature) => plan.features.includes(f);
  return (
    <ul className="plan-features">
      <li>
        <Icon name="check" size={14} /> {plan.member_limit ? `Up to ${plan.member_limit} members` : 'More than 50 members'}
      </li>
      <li>
        <Icon name="check" size={14} /> {storage(plan.storage_gb)} storage
      </li>
      <li>
        <Icon name="check" size={14} /> Projects, tasks, messaging, file sharing, knowledge and meetings
      </li>
      {all.map((f) => (
        <li key={f} className={has(f) ? '' : 'off'}>
          <Icon name={has(f) ? 'check' : 'x'} size={14} /> {FEATURE_LABEL[f]}
          {f === 'recordings' && has(f) ? (plan.recording_hours == null ? ' (unlimited)' : ` (${plan.recording_hours} hours a month)`) : ''}
          {f === 'ai' && has(f) && plan.ai_per_month ? ` (${plan.ai_per_month.toLocaleString()} requests a month)` : ''}
        </li>
      ))}
      <li className={plan.priority_support ? '' : 'off'}>
        <Icon name={plan.priority_support ? 'check' : 'x'} size={14} /> Priority support
      </li>
    </ul>
  );
}

/** How to get a plan that can't be bought in the app (Enterprise). */
export function contactHref(supportEmail: string | null | undefined, planName: string) {
  return supportEmail ? `mailto:${supportEmail}?subject=${encodeURIComponent(`Küü ${planName} quote`)}` : null;
}

export const FEATURE_ORDER: Feature[] = ['planning', 'fields', 'goals', 'recordings', 'automations', 'guests', 'insights', 'api', 'ai', 'sso', 'scim', 'retention'];
