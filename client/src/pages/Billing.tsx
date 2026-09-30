import { useState } from 'react';
import { api, type Feature, type PlanId, type PublicPlan } from '../api';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { FEATURE_ORDER, PlanFeatures, PlanPrice, contactHref, daysUntil, lrd, usd } from '../components/Plan';
import { ErrorState, Field, Loading, Modal, useAction } from '../components/ui';
import { bytes, dateTime, dateLabel } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';

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
  plan: {
    id: PlanId;
    name: string;
    status: 'trial' | 'active' | 'grace' | 'free';
    purchased: PlanId;
    trial_ends_at: string | null;
    paid_through: string | null;
    features: Feature[];
    custom?: boolean;
  };
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

/** A flat price per workspace; paying for 12 months at once applies the annual discount. */
export const totalFor = (price: number, months: number, annualFactor: number) => Math.round(price * months * (months >= 12 ? annualFactor : 1) * 100) / 100;

const hours = (seconds: number) => `${Math.round((seconds / 3600) * 10) / 10} h`;

function Meter({ label, used, limit, format = String }: { label: string; used: number; limit: number | null; format?: (n: number) => string }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="meter">
      <div className="row-gap">
        <span className="grow">{label}</span>
        <strong>
          {format(used)}
          {limit != null ? ` of ${format(limit)}` : ''}
        </strong>
      </div>
      {limit != null && (
        <div className={`meter-bar ${pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : ''}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

export function BillingSettings() {
  const { data, error, reload } = useApi<BillingData>('/billing');
  const act = useAction();
  const [paying, setPaying] = useState<PlanId | null>(null);
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading />;
  const { plan, usage } = data;

  const statusLine =
    plan.status === 'trial'
      ? `Organization trial — ${daysUntil(plan.trial_ends_at)} days left (ends ${dateLabel(plan.trial_ends_at)}). If you don't choose a plan, you move to Free and keep all your data.`
      : plan.status === 'active'
        ? `Paid until ${dateLabel(plan.paid_through)}.`
        : plan.status === 'grace'
          ? `Payment overdue since ${dateLabel(plan.paid_through)}. Paid features keep working for ${data.grace_days} days after that date.`
          : 'Free forever. Upgrade any time to unlock more.';

  return (
    <div className="stack">
      <div className="card billing-current">
        <div className="row-gap wrap">
          <div className="grow">
            <p className="eyebrow">CURRENT PLAN</p>
            <h2>
              {plan.name} <span className={`pill plan-${plan.status}`}>{plan.status === 'grace' ? 'overdue' : plan.status}</span>
            </h2>
            <p className="muted">{statusLine}</p>
          </div>
          {plan.status !== 'free' && plan.status !== 'trial' && (
            <button className="btn primary" onClick={() => setPaying(plan.purchased)}>
              Renew
            </button>
          )}
        </div>
        <div className="meters">
          <Meter label={usage.guests ? `Members (plus ${usage.guests} guest${usage.guests === 1 ? '' : 's'}, who don't count)` : 'Members'} used={usage.members} limit={usage.member_limit} />
          <Meter label="File storage" used={usage.storage_bytes} limit={usage.storage_limit} format={(n) => bytes(n)} />
          {!!usage.recording_hours && <Meter label="Meeting recording this month" used={usage.recording_seconds} limit={usage.recording_hours * 3600} format={hours} />}
          {!!usage.ai_limit && <Meter label={plan.status === 'trial' ? 'AI requests during trial' : 'AI requests this month'} used={usage.ai_used} limit={usage.ai_limit} />}
        </div>
        {plan.custom && <p className="muted small">Custom terms apply to this workspace, as agreed with us.</p>}
        {usage.blocked.length > 0 && (
          <div className="blocked-signals">
            <strong>Your team tried to use these in the last 30 days, and your plan stopped them:</strong>
            <ul>
              {usage.blocked.map((b) => (
                <li key={b.key}>
                  {b.label} <span className="muted">· {b.count} time{b.count === 1 ? '' : 's'}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="plan-grid">
        {data.plans.map((p) => {
          const current = plan.status !== 'trial' && plan.id === p.id;
          const tooSmall = p.member_limit != null && usage.members > p.member_limit;
          const contact = contactHref(data.support_email, p.name);
          return (
            <div key={p.id} className={`card plan-card ${p.id === 'organization' ? 'featured' : ''} ${current ? 'current' : ''}`}>
              {p.id === 'organization' && <span className="plan-badge">Includes AI</span>}
              <h3>{p.name}</h3>
              <PlanPrice plan={p} />
              {!!p.price && <p className="muted small">{lrd(p.price, data.lrd_per_usd) || 'Paid monthly or yearly'}</p>}
              <p className="muted">{p.tagline}</p>
              <PlanFeatures plan={p} all={FEATURE_ORDER} />
              {current ? (
                <button className="btn" disabled>
                  Current plan
                </button>
              ) : p.self_serve && tooSmall ? (
                <p className="muted small">
                  Your workspace has {usage.members} members; {p.name} allows up to {p.member_limit}.
                </p>
              ) : p.self_serve ? (
                <button className={`btn ${p.id === 'organization' ? 'primary' : ''}`} onClick={() => setPaying(p.id)}>
                  Choose {p.name}
                </button>
              ) : p.price == null ? (
                contact ? (
                  <a className="btn" href={contact}>
                    Contact us for a quote
                  </a>
                ) : (
                  <p className="muted small">Contact us for a quote.</p>
                )
              ) : (
                <p className="muted small">Workspaces move here automatically when a trial or paid plan ends.</p>
              )}
            </div>
          );
        })}
      </div>

      <div className="card">
        <h2>Payments</h2>
        {!data.payments.length && <p className="muted">No payments yet.</p>}
        {data.payments.length > 0 && (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Plan</th>
                  <th>Amount</th>
                  <th>Method</th>
                  <th>Reference</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.payments.map((p) => (
                  <tr key={p.id}>
                    <td>{dateTime(p.created_at)}</td>
                    <td>
                      {data.plans.find((x) => x.id === p.plan)?.name ?? p.plan} · {p.months} mo
                    </td>
                    <td>{usd(p.amount)}</td>
                    <td>{p.method_label}</td>
                    <td>
                      <code>{p.reference}</code>
                    </td>
                    <td>
                      <span className={`pill pay-${p.status}`}>{STATUS_TEXT[p.status]}</span>
                      {p.decision_note && <small className="muted block">{p.decision_note}</small>}
                      {p.status === 'approved' && p.period_end && <small className="muted block">Covers until {dateLabel(p.period_end)}</small>}
                    </td>
                    <td>
                      {p.status === 'pending' && (
                        <button className="btn sm" onClick={async () => (await act(() => api.del(`/billing/payments/${p.id}`), 'Payment cancelled')) && reload()}>
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.support_email && (
          <p className="muted small">
            Questions about billing? Email <a href={`mailto:${data.support_email}`}>{data.support_email}</a>.
          </p>
        )}
      </div>

      <PayModal data={data} plan={paying} onClose={() => setPaying(null)} onDone={reload} />
    </div>
  );
}

function PayModal({ data, plan, onClose, onDone }: { data: BillingData; plan: PlanId | null; onClose: () => void; onDone: () => void }) {
  const { me } = useSession();
  const act = useAction();
  const [form, setForm] = useState({ plan: plan ?? 'team', months: 1, method: data.methods[0]?.id ?? 'orange_money', reference: '', payerName: '', payerPhone: '', note: '' });
  const [done, setDone] = useState(false);
  const [lastPlan, setLastPlan] = useState(plan);
  if (plan !== lastPlan) {
    setLastPlan(plan);
    setDone(false);
    if (plan) setForm((f) => ({ ...f, plan, reference: '' }));
  }
  const chosen = data.plans.find((p) => p.id === form.plan)!;
  const total = chosen ? totalFor(chosen.price ?? 0, form.months, data.annual_factor) : 0;
  const switching = data.plan.status === 'active' && data.plan.purchased !== form.plan;

  return (
    <Modal open={!!plan} onClose={onClose} title={done ? 'Payment submitted' : `Pay for ${chosen?.name ?? ''}`} eyebrow="BILLING" wide>
      {done ? (
        <div className="stack">
          <p>
            Thank you. We'll check the payment and confirm it — usually within one business day. You'll get an email and a notification when it's done, and your plan
            starts then.
          </p>
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      ) : (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await act(() => api.post('/billing/payments', { ...form, months: Number(form.months) }));
            if (ok) {
              setDone(true);
              onDone();
            }
          }}
        >
          <div className="form-row">
            <Field label="Plan">
              <select value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value as PlanId })}>
                {data.plans
                  .filter((p) => p.self_serve && (p.member_limit == null || data.usage.members <= p.member_limit))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {usd(p.price ?? 0)} per workspace / month
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Pay for">
              <select value={form.months} onChange={(e) => setForm({ ...form, months: Number(e.target.value) })}>
                {data.month_options.map((m) => (
                  <option key={m} value={m}>
                    {m === 1 ? '1 month' : m === 12 ? '12 months (2 months free)' : `${m} months`}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="pay-total">
            <span className="grow">
              {usd(chosen.price ?? 0)} × {form.months} month{form.months === 1 ? '' : 's'}
              {form.months >= 12 ? ' − 2 months free' : ''}
              <small className="muted block">One price for the whole workspace, up to {chosen.member_limit} members. Guests don't count.</small>
            </span>
            <strong>
              {usd(total)} <small className="muted">{lrd(total, data.lrd_per_usd)}</small>
            </strong>
          </div>
          {switching && <p className="hint-box warn">Changing plans starts a new period on the day the payment is confirmed.</p>}
          <div className="pay-instructions">
            <h3>1. Send the payment</h3>
            {data.instructions ? (
              <Markdown text={data.instructions} />
            ) : (
              <p className="muted">Payment details haven't been set up yet{data.support_email ? `. Email ${data.support_email} to pay.` : '. Please contact support.'}</p>
            )}
            <p className="muted small">Pay exactly {usd(total)} and keep the transaction ID from your confirmation SMS or receipt.</p>
          </div>
          <h3>2. Tell us about it</h3>
          <div className="form-row">
            <Field label="Paid with">
              <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
                {data.methods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Transaction ID / reference">
              <input required minLength={3} maxLength={100} value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="e.g. MP240925.1234.A56789" />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Phone number used (optional)">
              <input type="tel" maxLength={40} value={form.payerPhone} onChange={(e) => setForm({ ...form, payerPhone: e.target.value })} placeholder="0770 000 000" />
            </Field>
            <Field label="Name on the account (optional)">
              <input maxLength={100} value={form.payerName} onChange={(e) => setForm({ ...form, payerName: e.target.value })} />
            </Field>
          </div>
          <Field label="Note (optional)">
            <input maxLength={500} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
          {!me?.user.email_verified && <p className="hint-box warn">Confirm your email address first — use the link in the banner at the top of the page.</p>}
          <div className="row-gap">
            <span className="grow" />
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={!me?.user.email_verified}>
              <Icon name="send" size={15} /> Submit payment
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
