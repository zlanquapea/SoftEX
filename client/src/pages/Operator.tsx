import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { Icon } from '../components/Icon';
import { daysUntil, usd } from '../components/Plan';
import { Empty, ErrorState, Field, Loading, Modal, Tabs, useAction } from '../components/ui';
import { bytes, dateTime, timeAgo } from '../format';
import { useApi, useDebounced } from '../hooks';

interface Summary {
  workspaces: { total: number; trial: number; active: number; grace: number; free: number; suspended: number };
  signups_7d: number;
  pending_payments: number;
  revenue_30d: number;
  mrr: number;
  users: number;
}

interface OpPayment {
  id: string;
  plan: string;
  months: number;
  seats: number;
  amount: number;
  method_label: string;
  reference: string;
  payer_name: string;
  payer_phone: string;
  note: string;
  status: string;
  decision_note: string;
  created_at: string;
  period_end: string | null;
  submitted_by: { id: string; name: string } | null;
  workspace?: { id: string; name: string };
}

interface OpWorkspace {
  id: string;
  name: string;
  created_at: string;
  suspended_at: string | null;
  suspended_reason: string | null;
  plan: { id: string; name: string; status: string; purchased: string; trial_ends_at: string | null; paid_through: string | null };
  owners: { name: string; email: string }[];
  usage: { members: number; seats: number; storage_bytes: number; storage_limit: number | null; ai_used: number; ai_limit: number | null };
  last_active_at: string | null;
  pending_payments: number;
}

type Tab = 'payments' | 'workspaces' | 'events';

/** Service operator console: approve payments, manage plans, suspend abuse. Metadata only — never workspace content. */
export function Operator() {
  const [tab, setTab] = useState<Tab>('payments');
  const summary = useApi<Summary>('/operator/summary');
  if (summary.error) {
    return (
      <div className="page">
        <ErrorState error={summary.error} />
        {(summary.error as { details?: { code?: string } }).details?.code === 'operator_mfa' && (
          <p className="center">
            <Link className="btn primary" to="/settings?tab=security">
              Set up multifactor authentication
            </Link>
          </p>
        )}
      </div>
    );
  }
  if (!summary.data) return <Loading />;
  const s = summary.data;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">SERVICE OPERATOR</p>
          <h1>Operator console</h1>
          <p className="muted">Customers, plans and payments across the whole service. You see sizes and dates, never workspace content.</p>
        </div>
      </div>
      <div className="measure-grid">
        <Tile label="Monthly recurring revenue" value={usd(s.mrr)} detail="Active paid plans, per month" />
        <Tile label="Confirmed last 30 days" value={usd(s.revenue_30d)} />
        <Tile label="Payments to confirm" value={String(s.pending_payments)} tone={s.pending_payments ? 'bad' : undefined} />
        <Tile label="Workspaces" value={String(s.workspaces.total)} detail={`${s.signups_7d} new this week · ${s.users} people`} />
        <Tile label="Paying" value={String(s.workspaces.active)} detail={`${s.workspaces.grace} overdue`} tone="good" />
        <Tile label="On trial" value={String(s.workspaces.trial)} />
        <Tile label="Free" value={String(s.workspaces.free)} />
        <Tile label="Suspended" value={String(s.workspaces.suspended)} />
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'payments', label: 'Payments to confirm', count: s.pending_payments },
          { id: 'workspaces', label: 'Workspaces' },
          { id: 'events', label: 'Activity log' },
        ]}
      />
      {tab === 'payments' && <PendingPayments onChange={summary.reload} />}
      {tab === 'workspaces' && <Workspaces onChange={summary.reload} />}
      {tab === 'events' && <Events />}
    </div>
  );
}

function Tile({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className={`card measure ${tone ?? ''}`}>
      <small className="muted">{label}</small>
      <strong className="measure-value">{value}</strong>
      {detail && <small className="muted">{detail}</small>}
    </div>
  );
}

function PaymentDetails({ p }: { p: OpPayment }) {
  return (
    <dl className="props compact">
      <dt>Amount</dt>
      <dd>
        <strong>{usd(p.amount)}</strong> — {p.plan}, {p.months} month{p.months === 1 ? '' : 's'}, {p.seats} member{p.seats === 1 ? '' : 's'}
      </dd>
      <dt>Method</dt>
      <dd>{p.method_label}</dd>
      <dt>Reference</dt>
      <dd>
        <code>{p.reference}</code>
      </dd>
      {p.payer_phone && (
        <>
          <dt>Phone</dt>
          <dd>{p.payer_phone}</dd>
        </>
      )}
      {p.payer_name && (
        <>
          <dt>Name</dt>
          <dd>{p.payer_name}</dd>
        </>
      )}
      {p.note && (
        <>
          <dt>Note</dt>
          <dd>{p.note}</dd>
        </>
      )}
      <dt>Submitted</dt>
      <dd>
        {dateTime(p.created_at)} by {p.submitted_by?.name ?? 'unknown'}
      </dd>
    </dl>
  );
}

function PendingPayments({ onChange }: { onChange: () => void }) {
  const act = useAction();
  const { data, error, reload } = useApi<OpPayment[]>('/operator/payments?status=pending');
  const [deciding, setDeciding] = useState<{ p: OpPayment; kind: 'approve' | 'reject' } | null>(null);
  const [text, setText] = useState('');
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading />;
  if (!data.length) return <Empty icon="check" title="No payments waiting">New mobile money and bank payments appear here for you to confirm.</Empty>;
  const decide = async () => {
    if (!deciding) return;
    const { p, kind } = deciding;
    const ok = await act(
      () => api.post(`/operator/payments/${p.id}/${kind}`, kind === 'approve' ? { note: text } : { reason: text }),
      kind === 'approve' ? 'Payment confirmed — the customer has been told' : 'Payment rejected — the customer has been told',
    );
    if (ok) {
      setDeciding(null);
      setText('');
      reload();
      onChange();
    }
  };
  return (
    <>
      <p className="muted">Check each payment arrived in your mobile money or bank account (match the reference and amount) before confirming it.</p>
      <ul className="later-list">
        {data.map((p) => (
          <li key={p.id} className="card op-payment">
            <div className="grow">
              <h3>{p.workspace?.name}</h3>
              <PaymentDetails p={p} />
            </div>
            <div className="stack">
              <button className="btn primary" onClick={() => setDeciding({ p, kind: 'approve' })}>
                <Icon name="check" size={15} /> Confirm
              </button>
              <button className="btn" onClick={() => setDeciding({ p, kind: 'reject' })}>
                Reject
              </button>
            </div>
          </li>
        ))}
      </ul>
      <Modal
        open={!!deciding}
        onClose={() => setDeciding(null)}
        title={deciding?.kind === 'approve' ? `Confirm ${usd(deciding.p.amount)} from ${deciding.p.workspace?.name}?` : 'Reject this payment?'}
        eyebrow="PAYMENT"
      >
        {deciding && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              decide();
            }}
          >
            <PaymentDetails p={deciding.p} />
            <Field label={deciding.kind === 'approve' ? 'Internal note (optional)' : 'Reason (shown to the customer)'}>
              <input value={text} onChange={(e) => setText(e.target.value)} required={deciding.kind === 'reject'} minLength={deciding.kind === 'reject' ? 3 : 0} maxLength={300} />
            </Field>
            <div className="row-gap">
              <span className="grow" />
              <button type="button" className="btn" onClick={() => setDeciding(null)}>
                Back
              </button>
              <button className={`btn ${deciding.kind === 'approve' ? 'primary' : 'danger'}`}>{deciding.kind === 'approve' ? 'Confirm payment' : 'Reject payment'}</button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}

const STATUS_LABEL: Record<string, string> = { trial: 'Trial', active: 'Paid', grace: 'Overdue', free: 'Free' };

function Workspaces({ onChange }: { onChange: () => void }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const debounced = useDebounced(q, 250);
  const { data, error, reload } = useApi<OpWorkspace[]>(`/operator/workspaces${qs({ q: debounced, status })}`);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      <div className="row-gap wrap toolbar">
        <input type="search" placeholder="Search by workspace or owner email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search workspaces" className="grow" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All</option>
          <option value="trial">On trial</option>
          <option value="active">Paying</option>
          <option value="grace">Overdue</option>
          <option value="free">Free</option>
          <option value="suspended">Suspended</option>
        </select>
      </div>
      {error && <ErrorState error={error} retry={reload} />}
      {!data && !error && <Loading />}
      {data && !data.length && <Empty icon="search" title="No workspaces match" />}
      {data && data.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Plan</th>
                <th>Members</th>
                <th>Storage</th>
                <th>AI this month</th>
                <th>Last active</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {data.map((w) => (
                <tr key={w.id} className="clickable" onClick={() => setOpenId(w.id)}>
                  <td>
                    <button className="link-btn" onClick={() => setOpenId(w.id)}>
                      <strong>{w.name}</strong>
                    </button>
                    <small className="muted block">{w.owners.map((o) => o.email).join(', ')}</small>
                  </td>
                  <td>
                    {w.suspended_at ? (
                      <span className="pill pay-rejected">Suspended</span>
                    ) : (
                      <span className={`pill plan-${w.plan.status}`}>
                        {w.plan.name} · {STATUS_LABEL[w.plan.status] ?? w.plan.status}
                      </span>
                    )}
                    {w.pending_payments > 0 && <small className="block">{w.pending_payments} payment(s) to confirm</small>}
                  </td>
                  <td>{w.usage.members}</td>
                  <td>{bytes(w.usage.storage_bytes)}</td>
                  <td>{w.usage.ai_used}</td>
                  <td>{w.last_active_at ? timeAgo(w.last_active_at) : '—'}</td>
                  <td>{w.created_at.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={!!openId} onClose={() => setOpenId(null)} title="Workspace" eyebrow="OPERATOR" wide>
        {openId && (
          <WorkspaceDetail
            id={openId}
            onChange={() => {
              reload();
              onChange();
            }}
          />
        )}
      </Modal>
    </>
  );
}

function WorkspaceDetail({ id, onChange }: { id: string; onChange: () => void }) {
  const act = useAction();
  const { data, error, reload } = useApi<OpWorkspace & { payments: OpPayment[]; events: { id: string; actor: string; action: string; created_at: string }[] }>(
    `/operator/workspaces/${id}`,
  );
  const [form, setForm] = useState<{ plan: string; paidThrough: string; trialEndsAt: string } | null>(null);
  const [reason, setReason] = useState('');
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const f = form ?? { plan: data.plan.purchased, paidThrough: data.plan.paid_through?.slice(0, 10) ?? '', trialEndsAt: data.plan.trial_ends_at?.slice(0, 10) ?? '' };
  const toIso = (d: string) => (d ? new Date(`${d}T23:59:59Z`).toISOString() : null);
  const save = async (body: Record<string, unknown>, message: string) => {
    if (await act(() => api.patch(`/operator/workspaces/${id}`, body), message)) {
      setForm(null);
      setReason('');
      reload();
      onChange();
    }
  };
  return (
    <div className="stack">
      <div>
        <h2>{data.name}</h2>
        <p className="muted">
          Created {data.created_at.slice(0, 10)} · Owners: {data.owners.map((o) => `${o.name} <${o.email}>`).join(', ')}
        </p>
        <p>
          <strong>{data.plan.name}</strong> ({STATUS_LABEL[data.plan.status] ?? data.plan.status})
          {data.plan.status === 'trial' && ` — ${daysUntil(data.plan.trial_ends_at)} days left`}
          {data.plan.paid_through && ` · paid through ${data.plan.paid_through.slice(0, 10)}`} · {data.usage.members} members ({data.usage.seats} billable) ·{' '}
          {bytes(data.usage.storage_bytes)} stored · {data.usage.ai_used} AI requests
        </p>
      </div>

      <form
        className="card form"
        onSubmit={(e) => {
          e.preventDefault();
          save({ plan: f.plan, paidThrough: toIso(f.paidThrough), trialEndsAt: toIso(f.trialEndsAt) }, 'Plan updated');
        }}
      >
        <h3>Plan (manual adjustment)</h3>
        <p className="muted small">Use this for discounts, extensions and corrections. Payments you confirm update the plan automatically.</p>
        <div className="form-row">
          <Field label="Plan">
            <select value={f.plan} onChange={(e) => setForm({ ...f, plan: e.target.value })}>
              <option value="free">Free</option>
              <option value="standard">Standard</option>
              <option value="business">Business</option>
            </select>
          </Field>
          <Field label="Paid through">
            <input type="date" value={f.paidThrough} onChange={(e) => setForm({ ...f, paidThrough: e.target.value })} />
          </Field>
          <Field label="Trial ends">
            <input type="date" value={f.trialEndsAt} onChange={(e) => setForm({ ...f, trialEndsAt: e.target.value })} />
          </Field>
        </div>
        <div className="form-actions">
          <button className="btn primary" disabled={!form}>
            Save plan
          </button>
        </div>
      </form>

      <div className="card form danger-zone">
        <h3>{data.suspended_at ? 'Suspended' : 'Suspend workspace'}</h3>
        {data.suspended_at ? (
          <>
            <p>
              Suspended {dateTime(data.suspended_at)}: {data.suspended_reason}
            </p>
            <button className="btn" onClick={() => save({ suspended: false }, 'Workspace restored')}>
              Restore access
            </button>
          </>
        ) : (
          <form
            className="row-gap wrap"
            onSubmit={(e) => {
              e.preventDefault();
              if (confirm(`Suspend ${data.name}? Everyone is signed out immediately.`)) save({ suspended: true, reason }, 'Workspace suspended');
            }}
          >
            <input className="grow" required placeholder="Reason (e.g. spam, abuse report)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
            <button className="btn danger">Suspend</button>
          </form>
        )}
        <p className="muted small">Suspension signs everyone out and blocks access until you restore it. Nothing is deleted.</p>
      </div>

      <div>
        <h3>Payments</h3>
        {!data.payments.length && <p className="muted">None yet.</p>}
        <ul className="run-log">
          {data.payments.map((p) => (
            <li key={p.id}>
              <span className={`pill pay-${p.status}`}>{p.status}</span>
              <span className="grow">
                {usd(p.amount)} · {p.plan} · {p.months} mo · {p.method_label} <code>{p.reference}</code>
              </span>
              <small className="muted">{p.created_at.slice(0, 10)}</small>
            </li>
          ))}
        </ul>
      </div>
      {data.events.length > 0 && (
        <div>
          <h3>Operator history</h3>
          <ul className="run-log">
            {data.events.map((e) => (
              <li key={e.id}>
                <span className="grow">
                  {e.action} <small className="muted">by {e.actor}</small>
                </span>
                <small className="muted">{timeAgo(e.created_at)}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Events() {
  const { data, error } = useApi<{ id: string; actor: string; action: string; workspace_name: string | null; detail: Record<string, unknown>; created_at: string }[]>('/operator/events');
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  if (!data.length) return <Empty icon="list" title="Nothing yet">Payments, plan changes, suspensions and deletions are recorded here.</Empty>;
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Action</th>
            <th>Workspace</th>
            <th>By</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {data.map((e) => (
            <tr key={e.id}>
              <td>{dateTime(e.created_at)}</td>
              <td>{e.action}</td>
              <td>{e.workspace_name ?? '—'}</td>
              <td>{e.actor}</td>
              <td>
                <code className="small">{JSON.stringify(e.detail)}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
