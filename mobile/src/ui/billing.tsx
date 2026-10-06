import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api, session, type Feature, type PlanId, type PublicPlan } from '../lib/api';
import { bytes, dateLabel, dateTime } from '../lib/format';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import { useTheme } from '../lib/theme';
import { Button, Card, ErrorState, Eyebrow, Field, Input, LinkText, Loading, Muted, Pill, ProgressBar, Row, Section, Select, Sheet, T, useAction } from './kit';
import { Markdown, openLink } from './Markdown';
import { daysUntil, FEATURE_ORDER, PlanFeatures, PlanPrice, usd } from './plan';

/**
 * App stores require their own payment systems for digital subscriptions, so store builds show
 * plans, usage and payment history, and send admins to the web to pay. Builds distributed
 * outside the stores can set EXPO_PUBLIC_KUU_IN_APP_PAYMENTS=1 to pay from the app.
 */
export const IN_APP_PAYMENTS = process.env.EXPO_PUBLIC_KUU_IN_APP_PAYMENTS === '1';

interface Payment {
  id: string;
  plan: PlanId;
  months: number;
  seats: number;
  amount: number;
  method: string;
  method_label: string;
  reference: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  decision_note: string;
  period_end: string | null;
  created_at: string;
  submitted_by: { id: string; name: string } | null;
}
interface BillingData {
  plan: { id: PlanId; name: string; status: 'trial' | 'active' | 'grace' | 'free'; purchased: PlanId; trial_ends_at: string | null; paid_through: string | null; features: Feature[]; custom?: boolean };
  usage: {
    members: number;
    member_limit: number | null;
    guests: number;
    storage_bytes: number;
    storage_limit: number | null;
    ai_used: number;
    ai_limit: number | null;
    recording_seconds: number;
    recording_hours: number | null;
    blocked: { key: string; label: string; count: number }[];
  };
  plans: PublicPlan[];
  lrd_per_usd: number | null;
  annual_factor: number;
  grace_days: number;
  month_options: number[];
  methods: { id: string; label: string }[];
  instructions: string | null;
  support_email: string | null;
  payments: Payment[];
}

const STATUS_TEXT: Record<Payment['status'], string> = { pending: 'Waiting for confirmation', approved: 'Confirmed', rejected: 'Not confirmed', cancelled: 'Cancelled' };
const STATUS_TONE = { pending: 'amber', approved: 'green', rejected: 'red', cancelled: 'neutral' } as const;
export const totalFor = (price: number, months: number, annualFactor: number) => Math.round(price * months * (months >= 12 ? annualFactor : 1) * 100) / 100;
const hours = (seconds: number) => `${Math.round((seconds / 3600) * 10) / 10} h`;
export const lrd = (n: number, rate: number | null | undefined) => (rate ? `≈ L$${Math.round(n * rate).toLocaleString()}` : '');

function Meter({ label, used, limit, format = String }: { label: string; used: number; limit: number | null; format?: (n: number) => string }) {
  const { c } = useTheme();
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <View style={{ gap: 6 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T size={14} style={{ flex: 1 }}>
          {label}
        </T>
        <T size={14} weight="bold">
          {format(used)}
          {limit != null ? ` of ${format(limit)}` : ''}
        </T>
      </Row>
      {limit != null && <ProgressBar value={pct} color={pct >= 90 ? c.red : pct >= 75 ? c.amber : c.accent} />}
    </View>
  );
}

export function BillingSettings() {
  const { c } = useTheme();
  const { data, error, reload } = useApi<BillingData>('/billing');
  const act = useAction();
  const [paying, setPaying] = useState<PlanId | null>(null);
  if (error && !data) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading inline />;
  const { plan, usage } = data;
  const statusLine =
    plan.status === 'trial'
      ? `Organization trial — ${daysUntil(plan.trial_ends_at)} days left (ends ${dateLabel(plan.trial_ends_at)}). If you don't choose a plan, you move to Free and keep all your data.`
      : plan.status === 'active'
        ? `Paid until ${dateLabel(plan.paid_through)}.`
        : plan.status === 'grace'
          ? `Payment overdue since ${dateLabel(plan.paid_through)}. Paid features keep working for ${data.grace_days} days after that date.`
          : 'Free forever. Upgrade any time to unlock more.';
  const webBilling = `${session.server}/admin?tab=billing`;

  return (
    <View style={{ gap: 14 }}>
      <Card style={{ gap: 12 }}>
        <Eyebrow>Current plan</Eyebrow>
        <Row gap={8}>
          <T size={22} weight="displayHeavy">
            {plan.name}
          </T>
          <Pill label={plan.status === 'grace' ? 'overdue' : plan.status} tone={plan.status === 'grace' ? 'red' : plan.status === 'trial' ? 'blue' : plan.status === 'active' ? 'green' : 'neutral'} />
        </Row>
        <Muted>{statusLine}</Muted>
        {IN_APP_PAYMENTS && plan.status !== 'free' && plan.status !== 'trial' && <Button variant="primary" title="Renew" onPress={() => setPaying(plan.purchased)} />}
        <Meter label={usage.guests ? `Members (plus ${usage.guests} guest${usage.guests === 1 ? '' : 's'}, who don't count)` : 'Members'} used={usage.members} limit={usage.member_limit} />
        <Meter label="File storage" used={usage.storage_bytes} limit={usage.storage_limit} format={(n) => bytes(n)} />
        {!!usage.recording_hours && <Meter label="Meeting recording this month" used={usage.recording_seconds} limit={usage.recording_hours * 3600} format={hours} />}
        {!!usage.ai_limit && <Meter label={plan.status === 'trial' ? 'AI requests during trial' : 'AI requests this month'} used={usage.ai_used} limit={usage.ai_limit} />}
        {plan.custom && <Muted size={12}>Custom terms apply to this workspace, as agreed with us.</Muted>}
        {usage.blocked.length > 0 && (
          <View style={{ gap: 4, padding: 12, borderRadius: 12, backgroundColor: c.amberSoft }}>
            <T size={14} weight="bold">
              Your team tried to use these in the last 30 days, and your plan stopped them:
            </T>
            {usage.blocked.map((b) => (
              <T key={b.key} size={14}>
                • {b.label}{' '}
                <T size={12} tone="muted">
                  · {b.count} time{b.count === 1 ? '' : 's'}
                </T>
              </T>
            ))}
          </View>
        )}
      </Card>

      {!IN_APP_PAYMENTS && (
        <Card style={{ gap: 8, borderColor: c.accentLine, backgroundColor: c.accentWash }}>
          <T weight="bold">Changing plans</T>
          <Muted>Plans are bought and renewed on the web. Sign in to Küü in a browser and open Administration → Billing.</Muted>
          <LinkText onPress={() => openLink(webBilling)}>Open billing on the web</LinkText>
        </Card>
      )}

      {data.plans.map((p) => {
        const current = plan.status !== 'trial' && plan.id === p.id;
        const tooSmall = p.member_limit != null && usage.members > p.member_limit;
        return (
          <Card key={p.id} style={{ gap: 10, borderColor: current ? c.accent : p.id === 'organization' ? c.accentLine : c.line, borderWidth: current ? 2 : 1 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T size={18} weight="display">
                {p.name}
              </T>
              {current ? <Pill label="Current plan" tone="accent" /> : p.id === 'organization' ? <Pill label="Includes AI" tone="blue" /> : null}
            </Row>
            <PlanPrice plan={p} />
            {!!p.price && <Muted size={12}>{lrd(p.price, data.lrd_per_usd) || 'Paid monthly or yearly'}</Muted>}
            <Muted>{p.tagline}</Muted>
            <PlanFeatures plan={p} all={FEATURE_ORDER} />
            {IN_APP_PAYMENTS && !current && p.self_serve && !tooSmall && <Button variant={p.id === 'organization' ? 'primary' : 'secondary'} title={`Choose ${p.name}`} onPress={() => setPaying(p.id)} />}
            {p.self_serve && tooSmall && !current && (
              <Muted size={12}>
                Your workspace has {usage.members} members; {p.name} allows up to {p.member_limit}.
              </Muted>
            )}
            {p.price == null && data.support_email && (
              <LinkText onPress={() => openLink(`mailto:${data.support_email}?subject=${encodeURIComponent(`Küü ${p.name} quote`)}`)}>Contact us for a quote</LinkText>
            )}
          </Card>
        );
      })}

      <Section title="Payments">
        {!data.payments.length && <Muted>No payments yet.</Muted>}
        {data.payments.map((p) => (
          <View key={p.id} style={{ gap: 4, paddingVertical: 10, borderTopWidth: 1, borderColor: c.line2 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T weight="bold">
                {data.plans.find((x) => x.id === p.plan)?.name ?? p.plan} · {p.months} mo · {usd(p.amount)}
              </T>
              <Pill label={STATUS_TEXT[p.status]} tone={STATUS_TONE[p.status]} />
            </Row>
            <Muted size={12}>
              {dateTime(p.created_at)} · {p.method_label} · {p.reference}
            </Muted>
            {!!p.decision_note && <Muted size={12}>{p.decision_note}</Muted>}
            {p.status === 'approved' && p.period_end && <Muted size={12}>Covers until {dateLabel(p.period_end)}</Muted>}
            {p.status === 'pending' && <Button small title="Cancel" onPress={async () => (await act(() => api.del(`/billing/payments/${p.id}`), 'Payment cancelled')) && reload()} />}
          </View>
        ))}
        {data.support_email && (
          <Row gap={4} wrap style={{ marginTop: 8 }}>
            <Muted size={12}>Questions about billing?</Muted>
            <LinkText size={12} onPress={() => openLink(`mailto:${data.support_email}`)}>
              {data.support_email}
            </LinkText>
          </Row>
        )}
      </Section>
      {IN_APP_PAYMENTS && <PaySheet data={data} plan={paying} onClose={() => setPaying(null)} onDone={reload} />}
    </View>
  );
}

function PaySheet({ data, plan, onClose, onDone }: { data: BillingData; plan: PlanId | null; onClose: () => void; onDone: () => void }) {
  const { c } = useTheme();
  const { me } = useSession();
  const act = useAction();
  const [form, setForm] = useState({ plan: plan ?? 'team', months: '1', method: data.methods[0]?.id ?? 'orange_money', reference: '', payerName: '', payerPhone: '', note: '' });
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (plan) {
      setDone(false);
      setForm((f) => ({ ...f, plan, reference: '' }));
    }
  }, [plan]);
  const chosen = data.plans.find((p) => p.id === form.plan);
  const months = Number(form.months);
  const total = chosen ? totalFor(chosen.price ?? 0, months, data.annual_factor) : 0;
  const switching = data.plan.status === 'active' && data.plan.purchased !== form.plan;
  return (
    <Sheet
      open={!!plan}
      onClose={onClose}
      title={done ? 'Payment submitted' : `Pay for ${chosen?.name ?? ''}`}
      eyebrow="Billing"
      full
      footer={
        done ? (
          <Button title="Close" variant="primary" full onPress={onClose} />
        ) : (
          <Button
            title="Submit payment"
            icon="send"
            variant="primary"
            full
            disabled={!me?.user.email_verified || form.reference.trim().length < 3}
            onPress={async () => {
              const ok = await act(() => api.post('/billing/payments', { ...form, months }));
              if (ok) {
                setDone(true);
                onDone();
              }
            }}
          />
        )
      }
    >
      {done ? (
        <T>Thank you. We'll check the payment and confirm it — usually within one business day. You'll get an email and a notification when it's done, and your plan starts then.</T>
      ) : (
        <>
          <Field label="Plan">
            <Select
              title="Plan"
              value={form.plan}
              onChange={(v) => setForm({ ...form, plan: v })}
              options={data.plans.filter((p) => p.self_serve && (p.member_limit == null || data.usage.members <= p.member_limit)).map((p) => ({ id: p.id, label: `${p.name} — ${usd(p.price ?? 0)} / month` }))}
            />
          </Field>
          <Field label="Pay for">
            <Select title="Pay for" value={form.months} onChange={(v) => setForm({ ...form, months: v })} options={data.month_options.map((m) => ({ id: String(m), label: m === 1 ? '1 month' : m === 12 ? '12 months (2 months free)' : `${m} months` }))} />
          </Field>
          {chosen && (
            <Row style={{ justifyContent: 'space-between', padding: 12, borderRadius: 12, backgroundColor: c.surface2 }}>
              <View style={{ flex: 1 }}>
                <T>
                  {usd(chosen.price ?? 0)} × {months} month{months === 1 ? '' : 's'}
                  {months >= 12 ? ' − 2 months free' : ''}
                </T>
                <Muted size={12}>One price for the whole workspace, up to {chosen.member_limit} members. Guests don't count.</Muted>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <T size={20} weight="displayHeavy">
                  {usd(total)}
                </T>
                <Muted size={11}>{lrd(total, data.lrd_per_usd)}</Muted>
              </View>
            </Row>
          )}
          {switching && <Muted>Changing plans starts a new period on the day the payment is confirmed.</Muted>}
          <T weight="display" size={16}>
            1. Send the payment
          </T>
          {data.instructions ? <Markdown text={data.instructions} size={14} /> : <Muted>Payment details haven't been set up yet{data.support_email ? `. Email ${data.support_email} to pay.` : '. Please contact support.'}</Muted>}
          <Muted size={12}>Pay exactly {usd(total)} and keep the transaction ID from your confirmation SMS or receipt.</Muted>
          <T weight="display" size={16}>
            2. Tell us about it
          </T>
          <Field label="Paid with">
            <Select title="Paid with" value={form.method} onChange={(v) => setForm({ ...form, method: v })} options={data.methods.map((m) => ({ id: m.id, label: m.label }))} />
          </Field>
          <Field label="Transaction ID / reference">
            <Input value={form.reference} onChangeText={(v) => setForm({ ...form, reference: v })} maxLength={100} placeholder="e.g. MP240925.1234.A56789" autoCapitalize="characters" />
          </Field>
          <Field label="Phone number used (optional)">
            <Input value={form.payerPhone} onChangeText={(v) => setForm({ ...form, payerPhone: v })} keyboardType="phone-pad" maxLength={40} />
          </Field>
          <Field label="Name on the account (optional)">
            <Input value={form.payerName} onChangeText={(v) => setForm({ ...form, payerName: v })} maxLength={100} />
          </Field>
          <Field label="Note (optional)">
            <Input value={form.note} onChangeText={(v) => setForm({ ...form, note: v })} maxLength={500} />
          </Field>
          {!me?.user.email_verified && <Muted>Confirm your email address first — use the link on Home.</Muted>}
        </>
      )}
    </Sheet>
  );
}
