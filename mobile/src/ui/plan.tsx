import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api, type Feature, type PublicPlan } from '../lib/api';
import { dateLabel } from '../lib/format';
import { useSession } from '../lib/session';
import { useTheme } from '../lib/theme';
import { Icon } from './Icon';
import { Button, LinkText, Muted, Row, T, useAction } from './kit';

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

export const FEATURE_ORDER: Feature[] = ['planning', 'fields', 'goals', 'recordings', 'automations', 'guests', 'insights', 'api', 'ai', 'sso', 'scim', 'retention'];

let catalog: Promise<PublicPlan[]> | null = null;
export const loadCatalog = () => (catalog ??= api.get<{ plans: PublicPlan[] }>('/public/plans').then((r) => r.plans).catch(() => ((catalog = null), [])));

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

export function usePlan() {
  const { me } = useSession();
  const plan = me?.workspace.plan;
  return { plan, saas: me?.mode === 'saas', has: (feature: Feature) => !plan || plan.features.includes(feature) };
}

export const daysUntil = (iso: string | null | undefined) => (iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)) : 0);
export const usd = (n: number) => `$${n.toFixed(n % 1 ? 2 : 0)}`;

export function UpgradeNotice({ feature, readOnly = false }: { feature: Feature; readOnly?: boolean }) {
  const { c } = useTheme();
  const { can } = useSession();
  const plan = useUpgradePlan(feature);
  return (
    <View style={{ flexDirection: 'row', gap: 12, padding: 14, borderRadius: 14, backgroundColor: c.accentWash, borderWidth: 1, borderColor: c.accentLine }} accessibilityRole="summary">
      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="spark" size={18} color={c.accentInk} />
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <T weight="bold">{readOnly ? `${FEATURE_LABEL[feature]} are read-only on your plan` : `${FEATURE_LABEL[feature]} is part of the ${plan ?? 'paid'} plan${plan ? '' : 's'}`}</T>
        <Muted>
          {readOnly
            ? `Everything already here stays readable. ${can('admin') ? `Upgrade${plan ? ` to ${plan}` : ''} to create and change them again.` : 'Ask a workspace admin to upgrade to make changes.'}`
            : can('admin')
              ? 'Upgrade to unlock it for your whole team. Nothing you already have changes.'
              : 'Ask a workspace admin to upgrade to unlock it.'}
        </Muted>
        {can('admin') && <Button title="See plans" small variant="primary" onPress={() => router.push('/billing')} style={{ marginTop: 4 }} />}
      </View>
    </View>
  );
}

function Banner({ tone, icon, children, action }: { tone: 'info' | 'warn'; icon: string; children: string; action?: React.ReactNode }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 10, padding: 12, borderRadius: 12, backgroundColor: tone === 'warn' ? c.amberSoft : c.accentWash, borderWidth: 1, borderColor: tone === 'warn' ? c.amberLine : c.accentLine }}>
      <Icon name={icon} size={16} color={tone === 'warn' ? c.amberInk : c.accentInk} />
      <View style={{ flex: 1, gap: 4 }}>
        <T size={13} tone="ink2">
          {children}
        </T>
        {action}
      </View>
    </View>
  );
}

/** Reminders at the top of Home: confirm your email, guest access, trial countdown, overdue payment. */
export function AccountBanners() {
  const { me, can } = useSession();
  const act = useAction();
  const [sent, setSent] = useState(false);
  if (!me) return null;
  const out = [];
  if (me.role === 'guest' && me.guest_expires_at) out.push(<Banner key="guest" tone="info" icon="clock">{`You are a guest in ${me.workspace.name}. Your access ends ${dateLabel(me.guest_expires_at)}.`}</Banner>);
  if (me.mode === 'saas') {
    const plan = me.workspace.plan;
    if (!me.user.email_verified)
      out.push(
        <Banner
          key="verify"
          tone="warn"
          icon="alert"
          action={
            <LinkText
              size={13}
              onPress={async () => {
                if (await act(() => api.post('/me/verify-email/resend'), 'Confirmation email sent')) setSent(true);
              }}
            >
              {sent ? 'Sent — check your inbox' : 'Resend link'}
            </LinkText>
          }
        >{`Please confirm your email address (${me.user.email}) to invite people, use AI and pay for a plan.`}</Banner>,
      );
    if (can('admin') && plan.status === 'trial' && daysUntil(plan.trial_ends_at) <= 14) {
      const days = daysUntil(plan.trial_ends_at);
      out.push(
        <Banner key="trial" tone="info" icon="clock" action={<LinkText size={13} onPress={() => router.push('/billing')}>See plans</LinkText>}>
          {`${days <= 1 ? 'Your Organization trial ends today.' : `${days} days left in your Organization trial.`} Choose a plan to keep every feature.`}
        </Banner>,
      );
    }
    if (can('admin') && plan.status === 'grace')
      out.push(
        <Banner key="grace" tone="warn" icon="alert" action={<LinkText size={13} onPress={() => router.push('/billing')}>Renew</LinkText>}>
          {`Your ${plan.name} plan ended on ${dateLabel(plan.paid_through)}. Renew within a few days to keep paid features.`}
        </Banner>,
      );
  }
  return out.length ? <View style={{ gap: 8 }}>{out}</View> : null;
}

const storageLabel = (gb: number) => (gb >= 1024 ? `${gb / 1024} TB` : `${gb} GB`);

export function PlanPrice({ plan }: { plan: PublicPlan }) {
  if (plan.price == null) return <T size={20} weight="displayHeavy">Custom quote</T>;
  return (
    <Row gap={6} style={{ alignItems: 'baseline' }}>
      <T size={26} weight="displayHeavy">
        {plan.price ? usd(plan.price) : '$0'}
      </T>
      <Muted>{plan.price ? 'per workspace / month' : 'forever'}</Muted>
    </Row>
  );
}

export function PlanFeatures({ plan, all = FEATURE_ORDER }: { plan: PublicPlan; all?: Feature[] }) {
  const { c } = useTheme();
  const has = (f: Feature) => plan.features.includes(f);
  const line = (on: boolean, text: string, key: string) => (
    <Row key={key} gap={8} style={{ alignItems: 'flex-start' }}>
      <View style={{ paddingTop: 3 }}>
        <Icon name={on ? 'check' : 'x'} size={14} color={on ? c.green : c.muted} />
      </View>
      <T size={14} tone={on ? 'ink' : 'muted'} style={{ flex: 1, textDecorationLine: on ? 'none' : 'line-through' }}>
        {text}
      </T>
    </Row>
  );
  return (
    <View style={{ gap: 6 }}>
      {line(true, plan.member_limit ? `Up to ${plan.member_limit} members` : 'More than 50 members', 'members')}
      {line(true, `${storageLabel(plan.storage_gb)} storage`, 'storage')}
      {line(true, 'Projects, tasks, messaging, file sharing, knowledge and meetings', 'core')}
      {all.map((f) =>
        line(
          has(f),
          `${FEATURE_LABEL[f]}${f === 'recordings' && has(f) ? (plan.recording_hours == null ? ' (unlimited)' : ` (${plan.recording_hours} hours a month)`) : ''}${f === 'ai' && has(f) && plan.ai_per_month ? ` (${plan.ai_per_month.toLocaleString()} requests a month)` : ''}`,
          f,
        ),
      )}
      {line(plan.priority_support, 'Priority support', 'support')}
    </View>
  );
}
