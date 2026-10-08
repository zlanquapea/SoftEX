import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { api, qs, type Feature } from '@/lib/api';
import { shareApiDownload } from '@/lib/files';
import { bytes, dateTime, timeAgo } from '@/lib/format';
import { useApi, useDebounced } from '@/lib/hooks';
import { useTheme } from '@/lib/theme';
import { Button, Card, confirm, Empty, ErrorState, Eyebrow, Field, H1, Input, ListRow, Loading, Muted, Pill, Row, Screen, SearchBox, Select, Sheet, T, Tabs, useAction } from '@/ui/kit';
import { DateField } from '@/ui/pickers';
import { daysUntil, FEATURE_LABEL, FEATURE_ORDER, usd } from '@/ui/plan';

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
export default function Operator() {
  const [tab, setTab] = useState<Tab>('payments');
  const summary = useApi<Summary>('/operator/summary');
  const title = <Stack.Screen options={{ title: 'Operator console' }} />;
  if (summary.error) {
    const mfa = (summary.error as { details?: { code?: string } }).details?.code === 'operator_mfa';
    return (
      <Screen>
        {title}
        <ErrorState error={summary.error} retry={summary.reload} />
        {mfa && <Button variant="primary" title="Set up multifactor authentication" onPress={() => router.push('/settings?tab=security')} />}
      </Screen>
    );
  }
  if (!summary.data) return <Loading />;
  const s = summary.data;
  return (
    <Screen refreshing={summary.refreshing} onRefresh={summary.refresh}>
      {title}
      <View style={{ gap: 4 }}>
        <Eyebrow>SERVICE OPERATOR</Eyebrow>
        <H1>Operator console</H1>
        <Muted>Customers, plans and payments across the whole service. You see sizes and dates, never workspace content.</Muted>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Tile label="Monthly recurring revenue" value={usd(s.mrr)} detail="Active paid plans, per month" />
        <Tile label="Confirmed last 30 days" value={usd(s.revenue_30d)} />
        <Tile label="Payments to confirm" value={String(s.pending_payments)} tone={s.pending_payments ? 'red' : undefined} />
        <Tile label="Workspaces" value={String(s.workspaces.total)} detail={`${s.signups_7d} new this week · ${s.users} people`} />
        <Tile label="Paying" value={String(s.workspaces.active)} detail={`${s.workspaces.grace} overdue`} tone="green" />
        <Tile label="On trial" value={String(s.workspaces.trial)} />
        <Tile label="Free" value={String(s.workspaces.free)} />
        <Tile label="Suspended" value={String(s.workspaces.suspended)} />
      </View>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'payments', label: 'Payments', count: s.pending_payments },
          { id: 'workspaces', label: 'Workspaces' },
          { id: 'events', label: 'Activity log' },
          { id: 'backups', label: 'Backups' },
        ]}
      />
      {tab === 'payments' && <PendingPayments onChange={summary.reload} />}
      {tab === 'workspaces' && <Workspaces onChange={summary.reload} />}
      {tab === 'events' && <Events />}
      {tab === 'backups' && <Backups />}
    </Screen>
  );
}

function Tile({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: 'green' | 'red' }) {
  return (
    <Card style={{ flexGrow: 1, flexBasis: '45%', gap: 2 }}>
      <Muted size={12}>{label}</Muted>
      <T size={22} weight="display" tone={tone ?? 'ink'}>
        {value}
      </T>
      {detail && <Muted size={12}>{detail}</Muted>}
    </Card>
  );
}

function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Row style={{ alignItems: 'flex-start' }}>
      <Muted style={{ width: 90 }}>{label}</Muted>
      <T size={14} style={{ flex: 1 }} selectable>
        {children}
      </T>
    </Row>
  );
}

function PaymentDetails({ p }: { p: OpPayment }) {
  return (
    <View style={{ gap: 4 }}>
      <Prop label="Amount">
        {usd(p.amount)} — {p.plan}, {p.months} month{p.months === 1 ? '' : 's'} ({p.seats} member{p.seats === 1 ? '' : 's'} when paid)
      </Prop>
      <Prop label="Method">{p.method_label}</Prop>
      <Prop label="Reference">{p.reference}</Prop>
      {!!p.payer_phone && <Prop label="Phone">{p.payer_phone}</Prop>}
      {!!p.payer_name && <Prop label="Name">{p.payer_name}</Prop>}
      {!!p.note && <Prop label="Note">{p.note}</Prop>}
      <Prop label="Submitted">
        {dateTime(p.created_at)} by {p.submitted_by?.name ?? 'unknown'}
      </Prop>
    </View>
  );
}

function PendingPayments({ onChange }: { onChange: () => void }) {
  const act = useAction();
  const { data, error, reload } = useApi<OpPayment[]>('/operator/payments?status=pending');
  const [deciding, setDeciding] = useState<{ p: OpPayment; kind: 'approve' | 'reject' } | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading inline />;
  if (!data.length) return <Empty icon="check" title="No payments waiting">New mobile money and bank payments appear here for you to confirm.</Empty>;
  const decide = async () => {
    if (!deciding) return;
    const { p, kind } = deciding;
    setBusy(true);
    const ok = await act(
      () => api.post(`/operator/payments/${p.id}/${kind}`, kind === 'approve' ? { note: text } : { reason: text }),
      kind === 'approve' ? 'Payment confirmed — the customer has been told' : 'Payment rejected — the customer has been told',
    );
    setBusy(false);
    if (ok !== undefined) {
      setDeciding(null);
      setText('');
      reload();
      onChange();
    }
  };
  const rejecting = deciding?.kind === 'reject';
  return (
    <>
      <Muted>Check each payment arrived in your mobile money or bank account (match the reference and amount) before confirming it.</Muted>
      {data.map((p) => (
        <Card key={p.id} style={{ gap: 10 }}>
          <T weight="display" size={17}>
            {p.workspace?.name}
          </T>
          <PaymentDetails p={p} />
          <Row>
            <Button variant="primary" icon="check" title="Confirm" onPress={() => setDeciding({ p, kind: 'approve' })} style={{ flex: 1 }} />
            <Button title="Reject" onPress={() => setDeciding({ p, kind: 'reject' })} style={{ flex: 1 }} />
          </Row>
        </Card>
      ))}
      <Sheet
        open={!!deciding}
        onClose={() => setDeciding(null)}
        eyebrow="PAYMENT"
        title={deciding ? (deciding.kind === 'approve' ? `Confirm ${usd(deciding.p.amount)} from ${deciding.p.workspace?.name}?` : 'Reject this payment?') : undefined}
        footer={
          <Row>
            <Button title="Back" onPress={() => setDeciding(null)} style={{ flex: 1 }} />
            <Button
              variant={rejecting ? 'danger' : 'primary'}
              title={rejecting ? 'Reject payment' : 'Confirm payment'}
              loading={busy}
              disabled={rejecting && text.trim().length < 3}
              onPress={decide}
              style={{ flex: 1 }}
            />
          </Row>
        }
      >
        {deciding && (
          <View style={{ gap: 12 }}>
            <PaymentDetails p={deciding.p} />
            <Field label={rejecting ? 'Reason (shown to the customer)' : 'Internal note (optional)'}>
              <Input value={text} onChangeText={setText} maxLength={300} />
            </Field>
          </View>
        )}
      </Sheet>
    </>
  );
}

const STATUS_LABEL: Record<string, string> = { trial: 'Trial', active: 'Paid', grace: 'Overdue', free: 'Free' };
const STATUS_PILL: Record<string, 'blue' | 'green' | 'amber' | 'neutral'> = { trial: 'blue', active: 'green', grace: 'amber', free: 'neutral' };

function Workspaces({ onChange }: { onChange: () => void }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const debounced = useDebounced(q, 250);
  const { data, error, reload } = useApi<OpWorkspace[]>(`/operator/workspaces${qs({ q: debounced, status })}`);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      <SearchBox value={q} onChangeText={setQ} placeholder="Search by workspace or owner email" />
      <Select
        title="Status"
        value={status}
        onChange={setStatus}
        options={[
          { id: '', label: 'All workspaces' },
          { id: 'trial', label: 'On trial' },
          { id: 'active', label: 'Paying' },
          { id: 'grace', label: 'Overdue' },
          { id: 'free', label: 'Free' },
          { id: 'suspended', label: 'Suspended' },
        ]}
      />
      {error && <ErrorState error={error} retry={reload} />}
      {!data && !error && <Loading inline />}
      {data && !data.length && <Empty icon="search" title="No workspaces match" />}
      {data && data.length > 0 && (
        <Card padded={false}>
          {data.map((w) => (
            <ListRow
              key={w.id}
              chevron
              onPress={() => setOpenId(w.id)}
              title={w.name}
              bold
              subtitle={`${w.owners.map((o) => o.email).join(', ')}\n${w.usage.members} members · ${bytes(w.usage.storage_bytes)} · ${w.usage.ai_used} AI · ${
                w.last_active_at ? `active ${timeAgo(w.last_active_at)}` : 'never active'
              }${w.pending_payments ? ` · ${w.pending_payments} payment(s) to confirm` : ''}`}
              right={
                w.suspended_at ? (
                  <Pill label="Suspended" tone="red" />
                ) : (
                  <Pill label={`${w.plan.name} · ${STATUS_LABEL[w.plan.status] ?? w.plan.status}`} tone={STATUS_PILL[w.plan.status] ?? 'neutral'} />
                )
              }
            />
          ))}
        </Card>
      )}
      <Sheet open={!!openId} onClose={() => setOpenId(null)} title="Workspace" eyebrow="OPERATOR" full>
        {openId && (
          <WorkspaceDetail
            id={openId}
            onChange={() => {
              reload();
              onChange();
            }}
          />
        )}
      </Sheet>
    </>
  );
}

const PLAN_OPTIONS = [
  { id: 'free', label: 'Free' },
  { id: 'starter', label: 'Starter' },
  { id: 'team', label: 'Team' },
  { id: 'organization', label: 'Organization' },
  { id: 'enterprise', label: 'Enterprise (custom quote)' },
];

function WorkspaceDetail({ id, onChange }: { id: string; onChange: () => void }) {
  const act = useAction();
  const { c } = useTheme();
  const { data, error, reload } = useApi<OpWorkspace & { payments: OpPayment[]; events: { id: string; actor: string; action: string; created_at: string }[] }>(
    `/operator/workspaces/${id}`,
  );
  const [form, setForm] = useState<{ plan: string; paidThrough: string; trialEndsAt: string } | null>(null);
  const [reason, setReason] = useState('');
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading inline />;
  const f = form ?? { plan: data.plan.purchased, paidThrough: data.plan.paid_through?.slice(0, 10) ?? '', trialEndsAt: data.plan.trial_ends_at?.slice(0, 10) ?? '' };
  const toIso = (d: string) => (d ? new Date(`${d}T23:59:59Z`).toISOString() : null);
  const save = async (body: Record<string, unknown>, message: string) => {
    if ((await act(() => api.patch(`/operator/workspaces/${id}`, body), message)) !== undefined) {
      setForm(null);
      setReason('');
      reload();
      onChange();
    }
  };
  return (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 4 }}>
        <T weight="display" size={20}>
          {data.name}
        </T>
        <Muted>
          Created {data.created_at.slice(0, 10)} · Owners: {data.owners.map((o) => `${o.name} <${o.email}>`).join(', ')}
        </Muted>
        <T size={14}>
          <T size={14} weight="bold">
            {data.plan.name}
          </T>{' '}
          ({STATUS_LABEL[data.plan.status] ?? data.plan.status})
          {data.plan.status === 'trial' && ` — ${daysUntil(data.plan.trial_ends_at)} days left`}
          {data.plan.paid_through && ` · paid through ${data.plan.paid_through.slice(0, 10)}`} · {data.usage.members} members, {data.usage.guests} guests ·{' '}
          {bytes(data.usage.storage_bytes)} stored · {data.usage.ai_used} AI requests
          {data.plan.custom && ' · custom terms'}
        </T>
        {!!data.upgrade_signals?.length && <Muted>Upgrade signals (30 days): {data.upgrade_signals.map((s) => `${s.label} ×${s.count}`).join(' · ')}</Muted>}
      </View>

      <Card style={{ gap: 10 }}>
        <T weight="display" size={16}>
          Plan (manual adjustment)
        </T>
        <Muted>Use this for discounts, extensions and corrections. Payments you confirm update the plan automatically.</Muted>
        <Field label="Plan">
          <Select title="Plan" value={f.plan} onChange={(plan) => setForm({ ...f, plan })} options={PLAN_OPTIONS} />
        </Field>
        <Field label="Paid through">
          <DateField label="Paid through" value={f.paidThrough || null} onChange={(v) => setForm({ ...f, paidThrough: v ?? '' })} />
        </Field>
        <Field label="Trial ends">
          <DateField label="Trial ends" value={f.trialEndsAt || null} onChange={(v) => setForm({ ...f, trialEndsAt: v ?? '' })} />
        </Field>
        <Button
          variant="primary"
          title="Save plan"
          disabled={!form}
          onPress={() => save({ plan: f.plan, paidThrough: toIso(f.paidThrough), trialEndsAt: toIso(f.trialEndsAt) }, 'Plan updated')}
        />
      </Card>

      <EntitlementsEditor key={JSON.stringify(data.overrides ?? {})} initial={data.overrides} onSave={(overrides, message) => save({ overrides }, message)} />

      <Card style={{ gap: 10, borderColor: c.redLine }}>
        <T weight="display" size={16}>
          {data.suspended_at ? 'Suspended' : 'Suspend workspace'}
        </T>
        {data.suspended_at ? (
          <>
            <T size={14}>
              Suspended {dateTime(data.suspended_at)}: {data.suspended_reason}
            </T>
            <Button title="Restore access" onPress={() => save({ suspended: false }, 'Workspace restored')} />
          </>
        ) : (
          <>
            <Input placeholder="Reason (e.g. spam, abuse report)" value={reason} onChangeText={setReason} maxLength={300} accessibilityLabel="Suspension reason" />
            <Button
              variant="danger"
              title="Suspend"
              disabled={!reason.trim()}
              onPress={async () => {
                if (await confirm(`Suspend ${data.name}?`, 'Everyone is signed out immediately.', 'Suspend')) save({ suspended: true, reason }, 'Workspace suspended');
              }}
            />
          </>
        )}
        <Muted>Suspension signs everyone out and blocks access until you restore it. Nothing is deleted.</Muted>
      </Card>

      <View style={{ gap: 8 }}>
        <T weight="display" size={16}>
          Payments
        </T>
        {!data.payments.length && <Muted>None yet.</Muted>}
        {data.payments.map((p) => (
          <Row key={p.id} style={{ alignItems: 'flex-start' }}>
            <Pill label={p.status} tone={p.status === 'approved' ? 'green' : p.status === 'rejected' ? 'red' : 'amber'} />
            <T size={13} style={{ flex: 1 }}>
              {usd(p.amount)} · {p.plan} · {p.months} mo · {p.method_label} · {p.reference}
            </T>
            <Muted size={12}>{p.created_at.slice(0, 10)}</Muted>
          </Row>
        ))}
      </View>
      {data.events.length > 0 && (
        <View style={{ gap: 8 }}>
          <T weight="display" size={16}>
            Operator history
          </T>
          {data.events.map((e) => (
            <Row key={e.id}>
              <T size={13} style={{ flex: 1 }}>
                {e.action} <Muted size={12}>by {e.actor}</Muted>
              </T>
              <Muted size={12}>{timeAgo(e.created_at)}</Muted>
            </Row>
          ))}
        </View>
      )}
    </View>
  );
}

function Events() {
  const { data, error, reload } = useApi<{ id: string; actor: string; action: string; workspace_name: string | null; detail: Record<string, unknown>; created_at: string }[]>(
    '/operator/events',
  );
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading inline />;
  if (!data.length) return <Empty icon="list" title="Nothing yet">Payments, plan changes, suspensions and deletions are recorded here.</Empty>;
  return (
    <Card padded={false}>
      {data.map((e) => (
        <ListRow
          key={e.id}
          title={`${e.action}${e.workspace_name ? ` · ${e.workspace_name}` : ''}`}
          titleLines={2}
          subtitle={`${dateTime(e.created_at)} · ${e.actor}\n${JSON.stringify(e.detail)}`}
        />
      ))}
    </Card>
  );
}

interface BackupStatus {
  supported: boolean;
  enabled: boolean;
  location: 's3' | 'local';
  every_hours: number;
  keep: number;
  last: { at: string; ok: boolean; name?: string; error?: string; last_success_at?: string } | null;
  backups: { name: string; size: number; created_at: string }[];
}

function Backups() {
  const act = useAction();
  const { data, error, reload } = useApi<BackupStatus>('/operator/backups');
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading inline />;
  if (!data.supported) {
    return (
      <Card style={{ gap: 6 }}>
        <T weight="display" size={17}>
          Backups
        </T>
        <Muted>
          This server stores its data in PostgreSQL. Back it up with your database provider (on Railway: open the Postgres service → Backups), and test a restore into a
          new database from time to time.
        </Muted>
      </Card>
    );
  }
  const stale = !data.last?.last_success_at || Date.now() - new Date(data.last.last_success_at).getTime() > (data.every_hours + 2) * 3600_000;
  return (
    <>
      <Card style={{ gap: 10 }}>
        <T weight="display" size={17}>
          Backups
        </T>
        <Muted>
          {data.enabled ? `A checked, compressed copy of the whole database is saved every ${data.every_hours} hours` : 'Automatic backups are off (SOFTEX_BACKUPS=off)'}, and
          the newest {data.keep} are kept {data.location === 's3' ? 'in your S3 bucket under backups/' : 'in the backups folder on the server’s volume'}.
          {data.location === 'local' && ' Download one regularly and keep it somewhere else, or set up S3 storage, so a lost volume doesn’t take the backups with it.'}
        </Muted>
        {data.last && !data.last.ok && (
          <T tone="red" size={14}>
            The last backup failed {timeAgo(data.last.at)}: {data.last.error}
          </T>
        )}
        {data.enabled && stale && (
          <T tone="red" size={14}>
            No successful backup in the last {data.every_hours + 2} hours.
          </T>
        )}
        <Button
          variant="primary"
          title={busy ? 'Backing up…' : 'Back up now'}
          loading={busy}
          onPress={async () => {
            setBusy(true);
            await act(() => api.post('/operator/backups'), 'Backup saved');
            setBusy(false);
            reload();
          }}
        />
        <Muted>
          To restore, set the service variable SOFTEX_RESTORE_BACKUP to a backup’s file name and redeploy; the current database is kept beside it. Remove the variable
          afterwards.
        </Muted>
      </Card>
      {!data.backups.length ? (
        <Empty icon="download" title="No backups yet">
          The first one is made within a few minutes of the server starting.
        </Empty>
      ) : (
        <Card padded={false}>
          {data.backups.map((b) => (
            <ListRow
              key={b.name}
              title={b.name}
              subtitle={`${bytes(b.size)} · ${dateTime(b.created_at)}`}
              right={
                <Button
                  small
                  icon="download"
                  title="Download"
                  onPress={() => act(() => shareApiDownload(`/operator/backups/${encodeURIComponent(b.name)}/download`, b.name))}
                />
              }
            />
          ))}
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
  ai_per_month?: number | null;
  recording_hours?: number | null;
  note: string;
}

const LIMITS: { key: 'members' | 'storage_gb' | 'ai_per_month' | 'recording_hours'; label: string }[] = [
  { key: 'members', label: 'Members' },
  { key: 'storage_gb', label: 'Storage (GB)' },
  { key: 'ai_per_month', label: 'AI requests / month' },
  { key: 'recording_hours', label: 'Recording hours / month' },
];

type Mode = 'plan' | 'on' | 'off';
const MODE_OPTIONS: { id: Mode; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'on', label: 'Always on' },
  { id: 'off', label: 'Off' },
];

/**
 * Custom deals, add-ons and comps for one workspace, on top of whatever plan it is on:
 * switch single features on or off, and raise or lower limits.
 */
function EntitlementsEditor({ initial, onSave }: { initial?: Overrides; onSave: (o: Overrides | null, message: string) => void }) {
  const start = initial ?? { grant: [], revoke: [], note: '' };
  const [mode, setMode] = useState<Record<string, Mode>>(() =>
    Object.fromEntries(FEATURE_ORDER.map((f) => [f, start.grant.includes(f) ? 'on' : start.revoke.includes(f) ? 'off' : 'plan'])),
  );
  const [limits, setLimits] = useState<Record<string, string>>(() =>
    Object.fromEntries(LIMITS.map(({ key }) => [key, key in start && start[key] !== undefined ? (start[key] === null ? 'unlimited' : String(start[key])) : ''])),
  );
  const [note, setNote] = useState(start.note ?? '');
  const [error, setError] = useState('');
  const build = (): Overrides => {
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
  const touched = FEATURE_ORDER.some((f) => mode[f] !== 'plan') || Object.values(limits).some((v) => v.trim()) || !!note.trim();
  const hasTerms = !!initial && (initial.grant.length > 0 || initial.revoke.length > 0 || LIMITS.some(({ key }) => key in initial));
  return (
    <Card style={{ gap: 10 }}>
      <T weight="display" size={16}>
        Custom terms
      </T>
      <Muted>
        For negotiated deals, add-ons and comps. These apply on top of the plan and stay when the plan changes. Leave everything on “Plan” and empty to follow the plan
        exactly.
      </Muted>
      {FEATURE_ORDER.map((f) => (
        <Row key={f}>
          <T size={14} style={{ flex: 1 }}>
            {FEATURE_LABEL[f]}
          </T>
          <View style={{ width: 150 }}>
            <Select title={FEATURE_LABEL[f]} value={mode[f]} onChange={(v) => setMode({ ...mode, [f]: v })} options={MODE_OPTIONS} />
          </View>
        </Row>
      ))}
      {LIMITS.map(({ key, label }) => (
        <Field key={key} label={label}>
          <Input value={limits[key]} onChangeText={(v) => setLimits({ ...limits, [key]: v })} placeholder="Plan limit" autoCapitalize="none" />
        </Field>
      ))}
      <Field label="Note (why, and until when)">
        <Input value={note} onChangeText={setNote} maxLength={300} placeholder="e.g. Pilot: AI on for 3 months, agreed with finance" />
      </Field>
      {!!error && (
        <T tone="red" size={14}>
          {error}
        </T>
      )}
      <Button
        variant="primary"
        title="Save custom terms"
        disabled={!touched && !initial}
        onPress={() => {
          setError('');
          try {
            onSave(build(), 'Custom terms saved');
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      />
      {hasTerms && <Button title="Remove custom terms" onPress={() => onSave(null, 'Custom terms removed')} />}
    </Card>
  );
}
