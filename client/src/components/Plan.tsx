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
  insights: 'Insights',
  guests: 'Guest access',
  api: 'API tokens and webhooks',
  sso: 'Single sign-on',
  scim: 'User provisioning (SCIM)',
  retention: 'Retention and legal hold',
};

const BUSINESS_ONLY: Feature[] = ['ai', 'sso', 'scim', 'retention'];

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
  const plan = BUSINESS_ONLY.includes(feature) ? 'Business' : 'Standard';
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
          <Icon name="clock" size={15} /> {days <= 1 ? 'Your Business trial ends today.' : `${days} days left in your Business trial.`} Choose a plan to keep every feature.
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

export function PlanFeatures({ plan, all }: { plan: PublicPlan; all: Feature[] }) {
  return (
    <ul className="plan-features">
      <li>
        <Icon name="check" size={14} /> {plan.member_limit ? `Up to ${plan.member_limit} members` : 'Unlimited members'}
      </li>
      <li>
        <Icon name="check" size={14} />{' '}
        {plan.storage_per_member_gb ? `${plan.storage_base_gb} GB + ${plan.storage_per_member_gb} GB per member` : `${plan.storage_base_gb} GB file storage`}
      </li>
      <li>
        <Icon name="check" size={14} /> Chat, channels, tasks, projects, knowledge, meetings and decisions
      </li>
      {all.map((f) => (
        <li key={f} className={plan.features.includes(f) ? '' : 'off'}>
          <Icon name={plan.features.includes(f) ? 'check' : 'x'} size={14} /> {FEATURE_LABEL[f]}
          {f === 'ai' && plan.ai_per_member ? ` (${plan.ai_per_member} requests per member each month)` : ''}
        </li>
      ))}
    </ul>
  );
}

export const FEATURE_ORDER: Feature[] = ['planning', 'automations', 'guests', 'insights', 'api', 'ai', 'sso', 'scim', 'retention'];
