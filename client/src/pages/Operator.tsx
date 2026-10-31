import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, qs, type Feature } from '../api';
import { Icon } from '../components/Icon';
import { daysUntil, FEATURE_LABEL, FEATURE_ORDER, usd } from '../components/Plan';
import {
  Callout,
  DatePicker,
  EmptyState,
  ErrorState,
  FilterBar,
  FormError,
  FormField,
  Loading,
  Modal,
  Page,
  PageHeader,
  Panel,
  Pill,
  SearchField,
  StatCard,
  StatGrid,
  TabBar,
  toneFor,
  useAction,
  useConfirm,
} from '@/components/kit';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { bytes, dateTime, timeAgo } from '../format';
import { useApi, useDebounced } from '../hooks';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

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
  plan: { id: string; name: string; status: string; purchased: string; trial_ends_at: string | null; paid_through: string | null; custom?: boolean };
  overrides?: Overrides;
  upgrade_signals?: { key: string; label: string; count: number }[];
  owners: { name: string; email: string }[];
  usage: { members: number; guests: number; storage_bytes: number; storage_limit: number | null; ai_used: number; ai_limit: number | null };
  last_active_at: string | null;
  pending_payments: number;
}

type Tab = 'payments' | 'workspaces' | 'events' | 'backups';

/** Service operator console: approve payments, manage plans, suspend abuse. Metadata only — never workspace content. */
export function Operator() {
  const [tab, setTab] = useState<Tab>('payments');
  const summary = useApi<Summary>('/operator/summary');
  if (summary.error) {
    return (
      <Page>
        <ErrorState error={summary.error} />
        {(summary.error as { details?: { code?: string } }).details?.code === 'operator_mfa' && (
          <Link to="/settings?section=security" className={buttonVariants({ className: 'mx-auto' })}>
            Set up multifactor authentication
          </Link>
        )}
      </Page>
    );
  }
  if (!summary.data) return <Loading />;
  const s = summary.data;
  return (
    <Page width="full" className="max-w-7xl">
      <PageHeader
        eyebrow="Service operator"
        title="Operator console"
        description="Customers, plans and payments across the whole service. You see sizes and dates, never workspace content."
      />
      <StatGrid>
        <StatCard label="Monthly recurring revenue" value={usd(s.mrr)} hint="Active paid plans, per month" />
        <StatCard label="Confirmed last 30 days" value={usd(s.revenue_30d)} />
        <StatCard label="Payments to confirm" value={s.pending_payments} tone={s.pending_payments ? 'danger' : undefined} />
        <StatCard label="Workspaces" value={s.workspaces.total} hint={`${s.signups_7d} new this week · ${s.users} people`} />
        <StatCard label="Paying" value={s.workspaces.active} hint={`${s.workspaces.grace} overdue`} tone="success" />
        <StatCard label="On trial" value={s.workspaces.trial} />
        <StatCard label="Free" value={s.workspaces.free} />
        <StatCard label="Suspended" value={s.workspaces.suspended} />
      </StatGrid>
      <TabBar
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'payments', label: 'Payments to confirm', count: s.pending_payments },
          { id: 'workspaces', label: 'Workspaces' },
          { id: 'events', label: 'Activity log' },
          { id: 'backups', label: 'Backups' },
        ]}
      />
      {tab === 'payments' && <PendingPayments onChange={summary.reload} />}
      {tab === 'workspaces' && <Workspaces onChange={summary.reload} />}
      {tab === 'events' && <Events />}
      {tab === 'backups' && <Backups />}
    </Page>
  );
}

/** One label/value pair in a compact details grid. */
function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function PaymentDetails({ p }: { p: OpPayment }) {
  return (
    <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
      <Detail label="Amount">
        <strong>{usd(p.amount)}</strong> — {p.plan}, {p.months} month{p.months === 1 ? '' : 's'} ({p.seats} member{p.seats === 1 ? '' : 's'} when paid)
      </Detail>
      <Detail label="Method">{p.method_label}</Detail>
      <Detail label="Reference">
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{p.reference}</code>
      </Detail>
      {p.payer_phone && <Detail label="Phone">{p.payer_phone}</Detail>}
      {p.payer_name && <Detail label="Name">{p.payer_name}</Detail>}
      {p.note && <Detail label="Note">{p.note}</Detail>}
      <Detail label="Submitted">
        {dateTime(p.created_at)} by {p.submitted_by?.name ?? 'unknown'}
      </Detail>
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
  if (!data.length) return <EmptyState icon="check" title="No payments waiting">New mobile money and bank payments appear here for you to confirm.</EmptyState>;
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
      <Callout tone="info">Check each payment arrived in your mobile money or bank account (match the reference and amount) before confirming it.</Callout>
      <div className="grid gap-3 lg:grid-cols-2">
        {data.map((p) => (
          <Card key={p.id} size="sm">
            <CardHeader>
              <CardTitle>{p.workspace?.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <PaymentDetails p={p} />
            </CardContent>
            <CardFooter className="justify-end gap-2">
              <Button variant="outline" onClick={() => setDeciding({ p, kind: 'reject' })}>
                Reject
              </Button>
              <Button onClick={() => setDeciding({ p, kind: 'approve' })}>
                <Icon name="check" data-icon="inline-start" /> Confirm
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
      <Modal
        open={!!deciding}
        onClose={() => setDeciding(null)}
        title={deciding?.kind === 'approve' ? `Confirm ${usd(deciding.p.amount)} from ${deciding.p.workspace?.name}?` : 'Reject this payment?'}
        eyebrow="Payment"
      >
        {deciding && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              decide();
            }}
          >
            <PaymentDetails p={deciding.p} />
            <FormField label={deciding.kind === 'approve' ? 'Internal note (optional)' : 'Reason (shown to the customer)'}>
              <Input value={text} onChange={(e) => setText(e.target.value)} required={deciding.kind === 'reject'} minLength={deciding.kind === 'reject' ? 3 : 0} maxLength={300} />
            </FormField>
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1" />
              <Button variant="outline" type="button" onClick={() => setDeciding(null)}>
                Back
              </Button>
              <Button type="submit" variant={deciding.kind === 'approve' ? 'default' : 'destructive'}>
                {deciding.kind === 'approve' ? 'Confirm payment' : 'Reject payment'}
              </Button>
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
      <FilterBar>
        <SearchField className="max-w-md flex-1" placeholder="Search by workspace or owner email" value={q} onChange={setQ} aria-label="Search workspaces" />
        <NativeSelect value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <NativeSelectOption value="">All</NativeSelectOption>
          <NativeSelectOption value="trial">On trial</NativeSelectOption>
          <NativeSelectOption value="active">Paying</NativeSelectOption>
          <NativeSelectOption value="grace">Overdue</NativeSelectOption>
          <NativeSelectOption value="free">Free</NativeSelectOption>
          <NativeSelectOption value="suspended">Suspended</NativeSelectOption>
        </NativeSelect>
      </FilterBar>
      {error && <ErrorState error={error} retry={reload} />}
      {!data && !error && <Loading />}
      {data && !data.length && <EmptyState icon="search" title="No workspaces match" />}
      {data && data.length > 0 && (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Members</TableHead>
                <TableHead>Storage</TableHead>
                <TableHead>AI this month</TableHead>
                <TableHead>Last active</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((w) => (
                <TableRow key={w.id} className="cursor-pointer" onClick={() => setOpenId(w.id)}>
                  <TableCell>
                    <Button variant="link" size="inline" className="font-semibold text-foreground" onClick={() => setOpenId(w.id)}>
                      {w.name}
                    </Button>
                    <span className="block text-xs text-muted-foreground">{w.owners.map((o) => o.email).join(', ')}</span>
                  </TableCell>
                  <TableCell>
                    {w.suspended_at ? (
                      <Pill tone="danger">Suspended</Pill>
                    ) : (
                      <Pill tone={toneFor(w.plan.status)}>
                        {w.plan.name} · {STATUS_LABEL[w.plan.status] ?? w.plan.status}
                      </Pill>
                    )}
                    {w.pending_payments > 0 && <span className="block text-xs text-warning">{w.pending_payments} payment(s) to confirm</span>}
                  </TableCell>
                  <TableCell className="tabular-nums">{w.usage.members}</TableCell>
                  <TableCell className="tabular-nums">{bytes(w.usage.storage_bytes)}</TableCell>
                  <TableCell className="tabular-nums">{w.usage.ai_used}</TableCell>
                  <TableCell>{w.last_active_at ? timeAgo(w.last_active_at) : '—'}</TableCell>
                  <TableCell>{w.created_at.slice(0, 10)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <Modal open={!!openId} onClose={() => setOpenId(null)} title="Workspace" eyebrow="Operator" wide>
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
  const confirm = useConfirm();
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 text-sm">
        <h2 className="font-heading text-lg font-semibold">{data.name}</h2>
        <p className="text-muted-foreground">
          Created {data.created_at.slice(0, 10)} · Owners: {data.owners.map((o) => `${o.name} <${o.email}>`).join(', ')}
        </p>
        <p>
          <strong>{data.plan.name}</strong> ({STATUS_LABEL[data.plan.status] ?? data.plan.status})
          {data.plan.status === 'trial' && ` — ${daysUntil(data.plan.trial_ends_at)} days left`}
          {data.plan.paid_through && ` · paid through ${data.plan.paid_through.slice(0, 10)}`} · {data.usage.members} members, {data.usage.guests} guests ·{' '}
          {bytes(data.usage.storage_bytes)} stored · {data.usage.ai_used} AI requests
          {data.plan.custom && ' · custom terms'}
        </p>
        {!!data.upgrade_signals?.length && (
          <p className="text-xs text-muted-foreground">
            <strong>Upgrade signals (30 days):</strong> {data.upgrade_signals.map((s) => `${s.label} ×${s.count}`).join(' · ')}
          </p>
        )}
      </div>

      <Panel title="Plan (manual adjustment)" description="Use this for discounts, extensions and corrections. Payments you confirm update the plan automatically.">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save({ plan: f.plan, paidThrough: toIso(f.paidThrough), trialEndsAt: toIso(f.trialEndsAt) }, 'Plan updated');
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="Plan">
              <NativeSelect value={f.plan} onChange={(e) => setForm({ ...f, plan: e.target.value })}>
                <NativeSelectOption value="free">Free</NativeSelectOption>
                <NativeSelectOption value="starter">Starter</NativeSelectOption>
                <NativeSelectOption value="team">Team</NativeSelectOption>
                <NativeSelectOption value="organization">Organization</NativeSelectOption>
                <NativeSelectOption value="enterprise">Enterprise (custom quote)</NativeSelectOption>
              </NativeSelect>
            </FormField>
            <FormField label="Paid through">
              <DatePicker value={f.paidThrough} onChange={(v) => setForm({ ...f, paidThrough: v ?? '' })} placeholder="Not set" />
            </FormField>
            <FormField label="Trial ends">
              <DatePicker value={f.trialEndsAt} onChange={(v) => setForm({ ...f, trialEndsAt: v ?? '' })} placeholder="Not set" />
            </FormField>
          </div>
          <div className="flex justify-end">
            <Button disabled={!form} type="submit">
              Save plan
            </Button>
          </div>
        </form>
      </Panel>

      <EntitlementsEditor key={JSON.stringify(data.overrides ?? {})} initial={data.overrides} onSave={(overrides, message) => save({ overrides }, message)} />

      <Panel
        className="ring-destructive/30"
        title={<span className="text-destructive">{data.suspended_at ? 'Suspended' : 'Suspend workspace'}</span>}
        footer={<p className="text-xs text-muted-foreground">Suspension signs everyone out and blocks access until you restore it. Nothing is deleted.</p>}
      >
        {data.suspended_at ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="flex-1 text-sm">
              Suspended {dateTime(data.suspended_at)}: {data.suspended_reason}
            </p>
            <Button variant="outline" onClick={() => save({ suspended: false }, 'Workspace restored')}>
              Restore access
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await confirm({ title: `Suspend ${data.name}?`, description: 'Everyone is signed out immediately.', confirmLabel: 'Suspend', destructive: true }))
                save({ suspended: true, reason }, 'Workspace suspended');
            }}
          >
            <Input className="min-w-40 flex-1" required placeholder="Reason (e.g. spam, abuse report)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
            <Button variant="destructive" type="submit">
              Suspend
            </Button>
          </form>
        )}
      </Panel>

      <Panel title="Payments">
        {!data.payments.length && <p className="text-sm text-muted-foreground">None yet.</p>}
        <ul className="flex flex-col divide-y text-sm">
          {data.payments.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
              <Pill tone={toneFor(p.status)} className="capitalize">
                {p.status}
              </Pill>
              <span className="min-w-0 flex-1">
                {usd(p.amount)} · {p.plan} · {p.months} mo · {p.method_label} <code className="rounded bg-muted px-1 font-mono text-xs">{p.reference}</code>
              </span>
              <span className="text-xs text-muted-foreground">{p.created_at.slice(0, 10)}</span>
            </li>
          ))}
        </ul>
      </Panel>
      {data.events.length > 0 && (
        <Panel title="Operator history">
          <ul className="flex flex-col divide-y text-sm">
            {data.events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="min-w-0 flex-1">
                  {e.action} <span className="text-xs text-muted-foreground">by {e.actor}</span>
                </span>
                <span className="text-xs text-muted-foreground">{timeAgo(e.created_at)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function Events() {
  const { data, error } = useApi<{ id: string; actor: string; action: string; workspace_name: string | null; detail: Record<string, unknown>; created_at: string }[]>('/operator/events');
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  if (!data.length) return <EmptyState icon="list" title="Nothing yet">Payments, plan changes, suspensions and deletions are recorded here.</EmptyState>;
  return (
    <Card className="py-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Workspace</TableHead>
            <TableHead>By</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((e) => (
            <TableRow key={e.id}>
              <TableCell>{dateTime(e.created_at)}</TableCell>
              <TableCell>{e.action}</TableCell>
              <TableCell>{e.workspace_name ?? '—'}</TableCell>
              <TableCell>{e.actor}</TableCell>
              <TableCell className="max-w-md truncate">
                <code className="font-mono text-xs">{JSON.stringify(e.detail)}</code>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

interface BackupStatus {
  supported: boolean;
  enabled: boolean;
  location: 's3' | 'gcs' | 'local';
  every_hours: number;
  keep: number;
  last: { at: string; ok: boolean; name?: string; error?: string; last_success_at?: string } | null;
  backups: { name: string; size: number; created_at: string }[];
}

function Backups() {
  const act = useAction();
  const { data, error, reload } = useApi<BackupStatus>('/operator/backups');
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  if (!data.supported) {
    return (
      <Panel title="Backups">
        <p className="text-sm text-muted-foreground">
          This server stores its data in PostgreSQL. Back it up with your database provider (on Railway: open the Postgres service → <em>Backups</em>), and test a restore into a
          new database from time to time.
        </p>
      </Panel>
    );
  }
  const stale = !data.last?.last_success_at || Date.now() - new Date(data.last.last_success_at).getTime() > (data.every_hours + 2) * 3600_000;
  return (
    <>
      <Panel
        title="Backups"
        action={
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await act(() => api.post('/operator/backups'), 'Backup saved');
              setBusy(false);
              reload();
            }}
          >
            {busy && <Spinner data-icon="inline-start" />}
            {busy ? 'Backing up…' : 'Back up now'}
          </Button>
        }
        footer={
          <p className="text-xs text-muted-foreground">
            To restore, set the service variable <Kbd>SOFTEX_RESTORE_BACKUP</Kbd> to a backup’s file name and redeploy; the current database is kept beside it. Remove the variable
            afterwards.
          </p>
        }
        contentClassName="flex flex-col gap-3"
      >
        <p className="text-sm text-muted-foreground">
          {data.enabled ? `A checked, compressed copy of the whole database is saved every ${data.every_hours} hours` : 'Automatic backups are off (SOFTEX_BACKUPS=off)'}, and the
          newest {data.keep} are kept {data.location !== 'local' ? 'in your storage bucket under backups/' : 'in the backups folder on the server’s volume'}.
          {data.location === 'local' && ' Download one regularly and keep it somewhere else, or set up S3 storage, so a lost volume doesn’t take the backups with it.'}
        </p>
        {data.last && !data.last.ok && (
          <Callout tone="danger">
            The last backup failed {timeAgo(data.last.at)}: {data.last.error}
          </Callout>
        )}
        {data.enabled && stale && <Callout tone="warning">No successful backup in the last {data.every_hours + 2} hours.</Callout>}
      </Panel>
      {!data.backups.length ? (
        <EmptyState icon="download" title="No backups yet">
          The first one is made within a few minutes of the server starting.
        </EmptyState>
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Backup</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Saved</TableHead>
                <TableHead>
                  <span className="sr-only">Download</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.backups.map((b) => (
                <TableRow key={b.name}>
                  <TableCell>
                    <code className="font-mono text-xs">{b.name}</code>
                  </TableCell>
                  <TableCell className="tabular-nums">{bytes(b.size)}</TableCell>
                  <TableCell>{dateTime(b.created_at)}</TableCell>
                  <TableCell className="text-right">
                    <a href={`/api/operator/backups/${encodeURIComponent(b.name)}/download`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                      <Icon name="download" data-icon="inline-start" />
                      Download
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </>
  );
}

// ======================= Entitlement overrides =======================

interface Overrides {
  grant: Feature[];
  revoke: Feature[];
  members?: number | null;
  storage_gb?: number | null;
  projects?: number | null;
  ai_per_month?: number | null;
  recording_hours?: number | null;
  note: string;
}

const LIMITS: { key: 'members' | 'storage_gb' | 'projects' | 'ai_per_month' | 'recording_hours'; label: string }[] = [
  { key: 'members', label: 'Members' },
  { key: 'storage_gb', label: 'Storage (GB)' },
  { key: 'projects', label: 'Active projects' },
  { key: 'ai_per_month', label: 'AI requests / month' },
  { key: 'recording_hours', label: 'Recording hours / month' },
];

/**
 * Custom deals, add-ons and comps for one workspace, on top of whatever plan it is on:
 * switch single features on or off, and raise or lower limits.
 */
function EntitlementsEditor({ initial, onSave }: { initial?: Overrides; onSave: (o: Overrides | null, message: string) => void }) {
  const start = initial ?? { grant: [], revoke: [], note: '' };
  const [mode, setMode] = useState<Record<string, 'plan' | 'on' | 'off'>>(() =>
    Object.fromEntries(FEATURE_ORDER.map((f) => [f, start.grant.includes(f) ? 'on' : start.revoke.includes(f) ? 'off' : 'plan'])),
  );
  const [limits, setLimits] = useState<Record<string, string>>(() =>
    Object.fromEntries(LIMITS.map(({ key }) => [key, key in start && start[key] !== undefined ? (start[key] === null ? 'unlimited' : String(start[key])) : ''])),
  );
  const [note, setNote] = useState(start.note ?? '');
  const [error, setError] = useState('');
  const build = (): Overrides | null => {
    const o: Overrides = {
      grant: FEATURE_ORDER.filter((f) => mode[f] === 'on'),
      revoke: FEATURE_ORDER.filter((f) => mode[f] === 'off'),
      note: note.trim(),
    };
    for (const { key, label } of LIMITS) {
      const v = limits[key].trim().toLowerCase();
      if (!v) continue;
      if (v === 'unlimited') o[key] = null;
      else if (Number.isFinite(Number(v)) && Number(v) >= 0) o[key] = Number(v);
      else throw new Error(`${label}: enter a number, “unlimited”, or leave it empty for the plan’s limit`);
    }
    return o;
  };
  const touched = FEATURE_ORDER.some((f) => mode[f] !== 'plan') || Object.values(limits).some((v) => v.trim()) || note.trim();
  return (
    <Panel
      title="Custom terms"
      description="For negotiated deals, add-ons and comps. These apply on top of the plan and stay when the plan changes. Leave everything on “Plan” and empty to follow the plan exactly."
    >
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError('');
        try {
          onSave(build(), 'Custom terms saved');
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {FEATURE_ORDER.map((f) => (
          <label key={f} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1">{FEATURE_LABEL[f]}</span>
            <NativeSelect size="sm" value={mode[f]} onChange={(e) => setMode({ ...mode, [f]: e.target.value as 'plan' | 'on' | 'off' })} aria-label={FEATURE_LABEL[f]}>
              <NativeSelectOption value="plan">Plan</NativeSelectOption>
              <NativeSelectOption value="on">Always on</NativeSelectOption>
              <NativeSelectOption value="off">Off</NativeSelectOption>
            </NativeSelect>
          </label>
        ))}
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-4">
        {LIMITS.map(({ key, label }) => (
          <FormField key={key} label={label}>
            <Input value={limits[key]} onChange={(e) => setLimits({ ...limits, [key]: e.target.value })} placeholder="Plan limit" />
          </FormField>
        ))}
      </div>
      <FormField label="Note (why, and until when)">
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. Pilot: AI on for 3 months, agreed with finance" />
      </FormField>
      <FormError>{error}</FormError>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {initial && (initial.grant.length || initial.revoke.length || LIMITS.some(({ key }) => key in initial)) ? (
          <Button variant="outline" type="button" onClick={() => onSave(null, 'Custom terms removed')}>
            Remove custom terms
          </Button>
        ) : null}
        <Button disabled={!touched && !initial} type="submit">
          Save custom terms
        </Button>
      </div>
    </form>
    </Panel>
  );
}
