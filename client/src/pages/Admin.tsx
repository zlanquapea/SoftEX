import { useState, type ReactNode } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs, type Channel, type Me, type Project } from '../api';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { WorkspaceInsights } from './Planning';
import { BillingSettings } from './Billing';
import { LimitNotice, UpgradeNotice, usePlan, usePlanUsage } from '../components/Plan';
import {
  Callout,
  DatePicker,
  EmptyState,
  FormField,
  IconButton,
  Loading,
  LoadingRows,
  Modal,
  notify,
  Page,
  PageHeader,
  Panel,
  PasswordInput,
  PeoplePicker,
  Pill,
  SearchField,
  SecretReveal,
  SwitchField,
  CategoryLayout,
  type Category,
  toneFor,
  useAction,
  useConfirm,
} from '@/components/kit';
import { Badge } from '@/components/ui/badge';
import { FieldLegend, FieldSet } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { dateTime, ROLE_LABEL, timeAgo } from '../format';
import { useApi } from '../hooks';
import { usePeople, useSession } from '../session';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Button, buttonVariants } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

type Tab = 'members' | 'invitations' | 'teams' | 'onboarding' | 'settings' | 'sso' | 'integrations' | 'email' | 'audit' | 'insights' | 'provisioning' | 'billing';

export function Admin() {
  const { can, me } = useSession();
  const { has } = usePlan();
  const [params, setParams] = useSearchParams();
  const isAdmin = can('admin');
  if (!can('lead')) return <Navigate to="/" replace />;
  const tabs: Category<Tab>[] = isAdmin
    ? [
        { id: 'members', label: 'Members', icon: 'users', hint: 'Roles, deactivation, guests', group: 'People' },
        { id: 'invitations', label: 'Invitations', icon: 'send', hint: 'Invite people, bulk import', group: 'People' },
        { id: 'teams', label: 'Teams', icon: 'users', hint: 'Groups of people and what they share', group: 'People' },
        { id: 'onboarding', label: 'Onboarding', icon: 'check', hint: 'What new members are asked to do', group: 'People' },
        { id: 'settings', label: 'Workspace', icon: 'settings', hint: 'Name, policies, retention', group: 'Workspace' },
        ...(me?.mode === 'saas' ? [{ id: 'billing' as Tab, label: 'Billing', icon: 'chart', hint: 'Plan and payments', group: 'Workspace' }] : []),
        { id: 'insights', label: 'Insights', icon: 'chart', hint: 'How the workspace is used', group: 'Workspace' },
        { id: 'sso', label: 'Single sign-on', icon: 'shield', hint: 'Sign in with your identity provider', group: 'Security & access' },
        { id: 'provisioning', label: 'Provisioning', icon: 'refresh', hint: 'SCIM user sync', group: 'Security & access' },
        { id: 'audit', label: 'Audit log', icon: 'list', hint: 'Who did what, and when', group: 'Security & access' },
        { id: 'integrations', label: 'Webhooks', icon: 'link', hint: 'Send events to other tools', group: 'Integrations' },
        { id: 'email', label: 'Email', icon: 'send', hint: 'Outgoing email and delivery', group: 'Integrations' },
      ]
    : [
        { id: 'insights', label: 'Insights', icon: 'chart', hint: 'How the workspace is used' },
        { id: 'invitations', label: 'Invitations', icon: 'send', hint: 'Invite people' },
        { id: 'teams', label: 'Teams', icon: 'users', hint: 'Groups of people and what they share' },
      ];
  const asked = (params.get('tab') as Tab | null) ?? null;
  return (
    <Page width="full" className="max-w-7xl">
      <PageHeader title="Administration" description="People, access, policies and the audit trail." />
      <CategoryLayout label="Administration categories" backLabel="Administration" showTitle={false} categories={tabs} open={asked} onOpen={(id) => setParams(id ? { tab: id } : {})}>
        {({ id: tab }) => (
          <>
      {tab === 'members' && isAdmin && <Members />}
      {tab === 'billing' && isAdmin && <BillingSettings />}
      {tab === 'insights' && (has('insights') ? <WorkspaceInsights /> : <UpgradeNotice feature="insights" />)}
      {tab === 'provisioning' && isAdmin && (has('scim') ? <ScimSettings /> : <UpgradeNotice feature="scim" />)}
      {tab === 'invitations' && <Invitations />}
      {tab === 'teams' && <Teams />}
      {tab === 'onboarding' && isAdmin && <OnboardingAdmin />}
      {tab === 'settings' && isAdmin && <WorkspaceSettings />}
      {tab === 'sso' && isAdmin && (has('sso') || me?.workspace.sso_enabled ? <SsoSettings /> : <UpgradeNotice feature="sso" />)}
      {tab === 'integrations' && isAdmin && (has('api') ? <Webhooks /> : <UpgradeNotice feature="api" />)}
      {tab === 'email' && isAdmin && <EmailOutbox />}
      {tab === 'audit' && isAdmin && <Audit />}
          </>
        )}
      </CategoryLayout>
    </Page>
  );
}

/** A list of checkboxes inside a bordered, scrollable box (channels, projects, events). */
function CheckList({ legend, items, value, onToggle }: { legend: ReactNode; items: { id: string; label: ReactNode }[]; value: string[]; onToggle: (id: string) => void }) {
  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label">{legend}</FieldLegend>
      <div className="grid max-h-48 gap-1 overflow-y-auto rounded-xl border p-1.5 sm:grid-cols-2">
        {items.map((i) => (
          <Label key={i.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 font-normal hover:bg-muted">
            <Checkbox checked={value.includes(i.id)} onCheckedChange={() => onToggle(i.id)} /> <span className="truncate">{i.label}</span>
          </Label>
        ))}
      </div>
    </FieldSet>
  );
}

interface Member {
  id: string;
  name: string;
  email: string;
  title: string;
  color: string;
  mfa_enabled: number;
  role: string;
  deactivated_at: string | null;
  guest_expires_at: string | null;
  joined_at: string;
  sponsor_name: string | null;
  last_session_at: string | null;
}

function Members() {
  const { me, reloadPeople } = useSession();
  const act = useAction();
  const confirm = useConfirm();
  const { data, reload } = useApi<Member[]>('/admin/members');
  const [q, setQ] = useState('');
  if (!data) return <Loading />;
  const update = async (m: Member, patch: Record<string, unknown>, msg: string) => {
    const ok = await act(() => api.patch(`/admin/members/${m.id}`, patch), msg);
    if (ok) {
      reload();
      reloadPeople();
    }
  };
  const list = data.filter((m) => !q || `${m.name} ${m.email}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Panel title="Members" action={<SearchField placeholder="Filter members" value={q} onChange={setQ} aria-label="Filter members" />}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Person</TableHead>
            <TableHead>Role</TableHead>
            <TableHead className="max-md:hidden">MFA</TableHead>
            <TableHead className="max-md:hidden">Last sign-in</TableHead>
            <TableHead>Access</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map((m) => (
            <TableRow key={m.id} className={cn(m.deactivated_at && 'opacity-60')}>
              <TableCell>
                <div className="flex items-center gap-2.5">
                  <Avatar user={m} size="sm" />
                  <div className="flex flex-col">
                    <strong className="font-medium">{m.name}</strong>
                    <span className="text-xs text-muted-foreground">{m.email}</span>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-col items-start gap-1.5">
                  <NativeSelect
                    size="sm"
                    value={m.role}
                    disabled={!!m.deactivated_at || (m.role === 'owner' && me!.role !== 'owner')}
                    onChange={(e) => update(m, { role: e.target.value }, 'Role updated')}
                    aria-label={`Role for ${m.name}`}
                  >
                    {Object.entries(ROLE_LABEL)
                      .filter(([r]) => r !== 'owner' || me!.role === 'owner' || m.role === 'owner')
                      .map(([r, label]) => (
                        <NativeSelectOption key={r} value={r}>
                          {label}
                        </NativeSelectOption>
                      ))}
                  </NativeSelect>
                  {m.role === 'guest' && (
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      Sponsor {m.sponsor_name ?? '—'} · until
                      <DatePicker
                        size="sm"
                        clearable={false}
                        value={m.guest_expires_at?.slice(0, 10)}
                        onChange={(v) => v && update(m, { guestExpiresAt: new Date(`${v}T23:59:59`).toISOString() }, 'Guest access updated')}
                        aria-label="Guest access end date"
                      />
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="max-md:hidden">{m.mfa_enabled ? <Pill tone="success"><Icon name="shield" /> On</Pill> : <span className="text-muted-foreground">Off</span>}</TableCell>
              <TableCell className="text-muted-foreground max-md:hidden">{m.last_session_at ? timeAgo(m.last_session_at) : '—'}</TableCell>
              <TableCell>
                {m.id !== me!.user.id &&
                  (m.deactivated_at ? (
                    <Button variant="outline" size="sm" onClick={() => update(m, { deactivated: false }, 'Member reactivated')}>
                      Reactivate
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={async () =>
                        (await confirm({ title: `Deactivate ${m.name}?`, description: 'They will be signed out everywhere immediately.', confirmLabel: 'Deactivate', destructive: true })) &&
                        update(m, { deactivated: true }, 'Member deactivated')
                      }
                    >
                      Deactivate
                    </Button>
                  ))}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

/** Paste a list of addresses, or upload a CSV exported from another tool. */
function BulkInvite({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { can } = useSession();
  const act = useAction();
  const [text, setText] = useState('');
  const [role, setRole] = useState('member');
  const [result, setResult] = useState<{ invited: string[]; skipped: { email: string; reason: string }[] } | null>(null);
  const close = () => {
    setText('');
    setResult(null);
    onClose();
  };
  return (
    <Modal open={open} onClose={close} title="Invite many people">
      {result ? (
        <div className="flex flex-col gap-3 text-sm">
          <p>
            <strong>{result.invited.length}</strong> invitation{result.invited.length === 1 ? '' : 's'} sent.
          </p>
          {result.skipped.length > 0 && (
            <>
              <p className="text-muted-foreground">Skipped:</p>
              <ul className="ml-4 list-disc">
                {result.skipped.map((s) => (
                  <li key={s.email}>
                    {s.email} <span className="text-muted-foreground">· {s.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="flex justify-end">
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const res = await act(() => api.post<{ invited: string[]; skipped: { email: string; reason: string }[] }>('/admin/invitations/bulk', { text, role }));
            if (res) {
              setResult(res);
              onDone();
            }
          }}
        >
          <p className="text-sm text-muted-foreground">
            Paste email addresses (one per line, or separated by commas), or upload a CSV from another tool. Every address found is invited; people who are already
            members or invited are skipped. Up to 200 at a time.
          </p>
          <FormField label="Email addresses">
            <Textarea rows={8} required value={text} onChange={(e) => setText(e.target.value)} placeholder={'amara@company.com\njoseph@company.com'} />
          </FormField>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-4">
            <FormField label="Or upload a CSV file">
              <Input
                type="file"
                accept=".csv,text/csv,text/plain"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) setText(await file.text());
                }}
              />
            </FormField>
            <FormField label="Role">
              <NativeSelect value={role} onChange={(e) => setRole(e.target.value)}>
                <NativeSelectOption value="member">Member</NativeSelectOption>
                {can('admin') && <NativeSelectOption value="lead">Team lead</NativeSelectOption>}
                {can('admin') && <NativeSelectOption value="admin">Admin</NativeSelectOption>}
              </NativeSelect>
            </FormField>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" type="button" onClick={close}>
              Cancel
            </Button>
            <Button type="submit">Send invitations</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function Invitations() {
  const { can } = useSession();
  const act = useAction();
  const { data, reload } = useApi<{ id: string; email: string; role: string; guest_days: number | null; expires_at: string; accepted_at: string | null; revoked_at: string | null; created_at: string; invited_by_name: string }[]>(
    '/admin/invitations',
  );
  const { data: channels } = useApi<Channel[]>('/channels');
  const { data: projects } = useApi<Project[]>('/projects');
  const [form, setForm] = useState({ email: '', role: 'member', guestDays: 30, channelIds: [] as string[], projectIds: [] as string[] });
  const [link, setLink] = useState<{ url: string; email: string } | null>(null);
  const [bulk, setBulk] = useState(false);
  const { usage } = usePlanUsage();
  const toggle = (key: 'channelIds' | 'projectIds', id: string) =>
    setForm({ ...form, [key]: form[key].includes(id) ? form[key].filter((x) => x !== id) : [...form[key], id] });
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <LimitNotice kind="members" usage={usage} className="lg:col-span-2" />
      <Panel title="Invite someone">
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const res = await act(() =>
              api.post<{ url: string }>('/admin/invitations', {
                ...form,
                guestDays: form.role === 'guest' ? form.guestDays : undefined,
                channelIds: form.channelIds,
                projectIds: form.projectIds,
              }),
            );
            if (res) {
              setLink({ url: `${location.origin}${res.url}`, email: form.email });
              setForm({ email: '', role: form.role, guestDays: 30, channelIds: [], projectIds: [] });
              reload();
            }
          }}
        >
          <FormField label="Email">
            <Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Role">
              <NativeSelect value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <NativeSelectOption value="member">Member</NativeSelectOption>
                <NativeSelectOption value="guest">Guest (partner, limited access)</NativeSelectOption>
                {can('admin') && <NativeSelectOption value="lead">Team lead</NativeSelectOption>}
                {can('admin') && <NativeSelectOption value="admin">Admin</NativeSelectOption>}
              </NativeSelect>
            </FormField>
            {form.role === 'guest' && (
              <FormField label="Access for (days)">
                <Input type="number" min={1} max={365} value={form.guestDays} onChange={(e) => setForm({ ...form, guestDays: Number(e.target.value) })} />
              </FormField>
            )}
          </div>
          <CheckList
            legend={form.role === 'guest' ? 'Share these channels (required for guests)' : 'Also add to channels'}
            items={(channels ?? []).filter((c) => c.kind !== 'dm').map((c) => ({ id: c.id, label: `#${c.name}` }))}
            value={form.channelIds}
            onToggle={(id) => toggle('channelIds', id)}
          />
          <CheckList legend="Projects" items={(projects ?? []).map((p) => ({ id: p.id, label: p.name }))} value={form.projectIds} onToggle={(id) => toggle('projectIds', id)} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit">Create invitation</Button>
            <Button variant="outline" type="button" onClick={() => setBulk(true)}>
              Invite many people at once
            </Button>
          </div>
          {link && (
            <SecretReveal title={`Invitation emailed to ${link.email}`} value={link.url}>
              <span className="text-xs">You can also share this link directly (valid for 14 days, shown only once).</span>
            </SecretReveal>
          )}
        </form>
      </Panel>
      <BulkInvite open={bulk} onClose={() => setBulk(false)} onDone={reload} />
      <Panel title="Invitations">
        {!data && <LoadingRows rows={3} />}
        {data && !data.length && <p className="text-sm text-muted-foreground">No invitations yet.</p>}
        <div className="flex flex-col divide-y">
          {data?.map((i) => {
            const state = i.accepted_at ? 'Accepted' : i.revoked_at ? 'Revoked' : new Date(i.expires_at) < new Date() ? 'Expired' : 'Pending';
            return (
              <div key={i.id} className="flex flex-wrap items-center gap-2 py-2.5">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <strong className="truncate font-medium">{i.email}</strong> <Pill>{ROLE_LABEL[i.role]}</Pill>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {state} · invited by {i.invited_by_name} {timeAgo(i.created_at)}
                  </span>
                </span>
                {(state === 'Pending' || state === 'Expired') && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      const res = await act(() => api.post<{ url: string }>(`/admin/invitations/${i.id}/resend`), `Invitation re-sent to ${i.email}`);
                      if (res) {
                        setLink({ url: `${location.origin}${res.url}`, email: i.email });
                        reload();
                      }
                    }}
                  >
                    Resend
                  </Button>
                )}
                {state === 'Pending' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={async () => {
                      await act(() => api.del(`/admin/invitations/${i.id}`), 'Invitation revoked');
                      reload();
                    }}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

function Teams() {
  const { can } = useSession();
  const people = usePeople();
  const act = useAction();
  const confirm = useConfirm();
  const { data, reload } = useApi<{ id: string; name: string; description: string; members: { id: string; name: string; color: string }[] }[]>('/teams');
  const [form, setForm] = useState({ name: '', description: '', memberIds: [] as string[] });
  const [editing, setEditing] = useState<string | null>(null);
  const [editIds, setEditIds] = useState<string[]>([]);
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Panel title="Teams">
        {!data && <LoadingRows rows={3} />}
        {data && !data.length && <EmptyState icon="users" title="No teams yet" />}
        <div className="flex flex-col divide-y">
          {data?.map((t) => (
            <div key={t.id} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="min-w-0 flex-1 font-semibold">{t.name}</strong>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditing(editing === t.id ? null : t.id);
                    setEditIds(t.members.map((m) => m.id));
                  }}
                >
                  {editing === t.id ? 'Close' : 'Edit members'}
                </Button>
                {can('admin') && (
                  <IconButton
                    label={`Delete ${t.name}`}
                    size="icon-sm"
                    onClick={async () => {
                      if (!(await confirm({ title: `Delete team ${t.name}?`, confirmLabel: 'Delete team', destructive: true }))) return;
                      await act(() => api.del(`/teams/${t.id}`), 'Team deleted');
                      reload();
                    }}
                  >
                    <Icon name="trash" />
                  </IconButton>
                )}
              </div>
              {t.description && <p className="text-sm text-muted-foreground">{t.description}</p>}
              {editing === t.id ? (
                <div className="flex flex-col gap-2">
                  <PeoplePicker people={people} value={editIds} onChange={setEditIds} />
                  <Button
                    size="sm"
                    className="self-end"
                    onClick={async () => {
                      await act(() => api.patch(`/teams/${t.id}`, { memberIds: editIds }), 'Team updated');
                      setEditing(null);
                      reload();
                    }}
                  >
                    Save members
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {t.members.map((m) => (
                    <Badge key={m.id} variant="outline" className="h-6 gap-1.5 pl-0.5">
                      <Avatar user={m} size="xs" /> {m.name}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </Panel>
      <Panel title="New team">
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await act(() => api.post('/teams', form), 'Team created');
            if (ok) {
              setForm({ name: '', description: '', memberIds: [] });
              reload();
            }
          }}
        >
          <FormField label="Name">
            <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </FormField>
          <FormField label="Description">
            <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </FormField>
          <FormField label="Members">
            <PeoplePicker people={people} value={form.memberIds} onChange={(ids) => setForm({ ...form, memberIds: ids })} />
          </FormField>
          <Button type="submit" className="self-end">
            Create team
          </Button>
        </form>
      </Panel>
    </div>
  );
}

function OnboardingAdmin() {
  const act = useAction();
  const { data, reload } = useApi<{ id: string; title: string; description: string; link: string; role: string | null }[]>('/onboarding/items');
  const [form, setForm] = useState({ title: '', description: '', link: '', role: '' });
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Panel title="Onboarding checklist" description="New members see these steps on Home until they complete them.">
        <div className="flex flex-col divide-y">
          {data?.map((i) => (
            <div key={i.id} className="flex items-center gap-3 py-2.5">
              <Icon name="flag" size={16} className="text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <strong className="font-medium">{i.title}</strong> {i.role && <Pill>{ROLE_LABEL[i.role]} only</Pill>}
                </span>
                {i.description && <span className="text-xs text-muted-foreground">{i.description}</span>}
              </span>
              <IconButton
                label={`Remove ${i.title}`}
                size="icon-xs"
                onClick={async () => {
                  await act(() => api.del(`/onboarding/items/${i.id}`));
                  reload();
                }}
              >
                <Icon name="x" />
              </IconButton>
            </div>
          ))}
        </div>
        {data && !data.length && <p className="text-sm text-muted-foreground">No steps yet.</p>}
      </Panel>
      <Panel title="Add a step">
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await act(() => api.post('/onboarding/items', { ...form, role: form.role || null }), 'Step added');
            if (ok) {
              setForm({ title: '', description: '', link: '', role: '' });
              reload();
            }
          }}
        >
          <FormField label="Title">
            <Input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Read the handbook" />
          </FormField>
          <FormField label="Description">
            <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </FormField>
          <FormField label="Link (optional)" hint="A knowledge page like /knowledge/… or an external URL.">
            <Input value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} />
          </FormField>
          <FormField label="For">
            <NativeSelect value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <NativeSelectOption value="">Everyone</NativeSelectOption>
              {Object.entries(ROLE_LABEL).map(([r, l]) => (
                <NativeSelectOption key={r} value={r}>
                  {l}s
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FormField>
          <Button type="submit" className="self-end">
            Add step
          </Button>
        </form>
      </Panel>
    </div>
  );
}

function WorkspaceSettings() {
  const { me, refresh } = useSession();
  const act = useAction();
  const ws = me!.workspace;
  const [form, setForm] = useState({
    name: ws.name,
    messageEditPolicy: ws.message_edit_policy,
    guestDefaultDays: ws.guest_default_days,
    requireMfa: ws.require_mfa,
    aiEnabled: ws.ai_enabled,
    retentionDays: ws.retention_days as number | null,
    legalHold: ws.legal_hold,
  });
  const { has } = usePlan();
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Panel title="Workspace">
        <form
          className="flex flex-col gap-5"
          onSubmit={async (e) => {
            e.preventDefault();
            // Settings for features outside the current plan are left as they are.
            const { aiEnabled, retentionDays, legalHold, ...rest } = form;
            const payload = { ...rest, ...(has('ai') ? { aiEnabled } : {}), ...(has('retention') ? { retentionDays, legalHold } : {}) };
            const ok = await act(() => api.patch('/admin/workspace', payload), 'Workspace settings saved');
            if (ok) refresh();
          }}
        >
          <FormField label="Workspace name">
            <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </FormField>
          <FormField label="Message editing and deletion">
            <NativeSelect value={form.messageEditPolicy} onChange={(e) => setForm({ ...form, messageEditPolicy: e.target.value as typeof form.messageEditPolicy })}>
              <NativeSelectOption value="author">Authors can edit and delete their messages</NativeSelectOption>
              <NativeSelectOption value="admins">Only admins can edit or delete</NativeSelectOption>
              <NativeSelectOption value="none">No editing (admins can still delete)</NativeSelectOption>
            </NativeSelect>
          </FormField>
          <FormField label="Default guest access (days)">
            <Input type="number" min={1} max={365} value={form.guestDefaultDays} onChange={(e) => setForm({ ...form, guestDefaultDays: Number(e.target.value) })} />
          </FormField>
          <SwitchField
            label="Require multifactor authentication"
            description="Members without MFA must set it up before they can continue."
            checked={form.requireMfa}
            onCheckedChange={(checked) => setForm({ ...form, requireMfa: checked })}
          />
          <SwitchField
            label="AI assistance"
            description={
              !has('ai')
                ? 'Available on the Organization plan.'
                : ws.ai_available
                  ? 'Lets people draft thread and meeting summaries, task suggestions and project briefs with Claude. It only reads content the requesting person can already open, drafts are never shared automatically, every use is audited, and channel or project owners can exclude their spaces.'
                  : 'Not available: the server administrator must set ANTHROPIC_API_KEY first.'
            }
            checked={form.aiEnabled && has('ai')}
            disabled={!ws.ai_available || !has('ai')}
            onCheckedChange={(checked) => setForm({ ...form, aiEnabled: checked })}
          />
          <Separator />
          <h3 className="font-semibold">Retention</h3>
          {!has('retention') && <UpgradeNotice feature="retention" compact />}
          <fieldset disabled={!has('retention')} className="flex flex-col gap-5 disabled:opacity-60">
            <FormField
              label="Keep messages for"
              hint="Older messages are deleted automatically (a thread is kept while it has recent replies). Knowledge pages, decisions, tasks and library files are kept."
            >
              <NativeSelect value={form.retentionDays ?? ''} onChange={(e) => setForm({ ...form, retentionDays: e.target.value ? Number(e.target.value) : null })}>
                <NativeSelectOption value="">Forever</NativeSelectOption>
                {[30, 90, 180, 365, 730, 1095, 1825, 2555, 3650].map((d) => (
                  <NativeSelectOption key={d} value={d}>
                    {d < 365 ? `${d} days` : `${Math.round(d / 365)} year${d >= 730 ? 's' : ''}`}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormField>
            <SwitchField
              label="Legal hold"
              description="Pauses all automatic deletion while an investigation or litigation is underway. Changes are recorded in the audit log."
              checked={form.legalHold}
              disabled={!has('retention')}
              onCheckedChange={(checked) => setForm({ ...form, legalHold: checked })}
            />
          </fieldset>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <a href="/api/export" className={buttonVariants({ variant: 'outline' })}>
              <Icon name="download" data-icon="inline-start" />
              Export data
            </a>
            <Button type="submit">Save settings</Button>
          </div>
        </form>
      </Panel>
      {me!.role === 'owner' && <DeleteWorkspace />}
    </div>
  );
}

function Audit() {
  const [action, setAction] = useState('');
  const { data } = useApi<{ id: string; action: string; actor_name: string | null; target_type: string; target_id: string; detail: Record<string, unknown>; created_at: string }[]>(
    `/admin/audit${qs({ action, limit: 200 })}`,
  );
  return (
    <Panel
      title="Audit log"
      action={
        <NativeSelect size="sm" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action">
          <NativeSelectOption value="">All events</NativeSelectOption>
          <NativeSelectOption value="auth">Sign-ins</NativeSelectOption>
          <NativeSelectOption value="member">Member changes</NativeSelectOption>
          <NativeSelectOption value="invitation">Invitations</NativeSelectOption>
          <NativeSelectOption value="guest">Guest access</NativeSelectOption>
          <NativeSelectOption value="project">Projects</NativeSelectOption>
          <NativeSelectOption value="channel">Channels</NativeSelectOption>
          <NativeSelectOption value="file">Files</NativeSelectOption>
          <NativeSelectOption value="workspace">Workspace settings</NativeSelectOption>
          <NativeSelectOption value="data">Exports</NativeSelectOption>
        </NativeSelect>
      }
    >
      {!data && <LoadingRows rows={4} />}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Who</TableHead>
            <TableHead>Action</TableHead>
            <TableHead className="max-md:hidden">Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data?.map((e) => (
            <TableRow key={e.id}>
              <TableCell>{dateTime(e.created_at)}</TableCell>
              <TableCell>{e.actor_name ?? 'System'}</TableCell>
              <TableCell>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{e.action}</code>
              </TableCell>
              <TableCell className="max-w-md truncate text-xs text-muted-foreground max-md:hidden">
                {Object.entries(e.detail)
                  .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
                  .join(' · ')}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

function DeleteWorkspace() {
  const { me, setMe } = useSession();
  const act = useAction();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ confirmName: '', password: '', code: '' });
  const name = me!.workspace.name;
  return (
    <Panel
      className="ring-destructive/30"
      title={<span className="text-destructive">Delete workspace</span>}
      description={`Permanently deletes ${name} for everyone: messages, files, tasks, projects, knowledge, meetings and settings. This can't be undone. Export your data first if you may need it.`}
    >
      <Button variant="destructive" className="self-start" onClick={() => setOpen(true)}>
        Delete this workspace
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Delete ${name}?`} eyebrow="Danger">
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const res = await act(() => api.del<{ me: Me | null }>('/admin/workspace', { ...form, code: form.code || undefined }));
            if (res) {
              setMe(res.me);
              navigate('/');
            }
          }}
        >
          <p className="text-sm">
            Everything in <strong>{name}</strong> will be deleted, and all {me!.workspace.member_count} members lose access immediately.
          </p>
          <FormField label={`Type the workspace name (${name}) to confirm`}>
            <Input required value={form.confirmName} onChange={(e) => setForm({ ...form, confirmName: e.target.value })} autoComplete="off" />
          </FormField>
          <FormField label="Your password">
            <Input required type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="current-password" />
          </FormField>
          {me!.user.mfa_enabled && (
            <FormField label="Authenticator code">
              <Input required inputMode="numeric" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} autoComplete="one-time-code" />
            </FormField>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1" />
            <Button variant="outline" type="button" onClick={() => setOpen(false)}>
              Keep workspace
            </Button>
            <Button
              variant="destructive"
              disabled={form.confirmName.trim() !== name}
              type="submit">
              Delete forever
            </Button>
          </div>
        </form>
      </Modal>
    </Panel>
  );
}

function SsoSettings() {
  const act = useAction();
  const { data, reload } = useApi<{
    available: boolean;
    enabled: boolean;
    issuer: string;
    client_id: string;
    has_client_secret: boolean;
    domain: string;
    required: boolean;
    auto_provision: boolean;
    redirect_uri: string;
  }>('/admin/sso');
  const [form, setForm] = useState<null | { enabled: boolean; issuer: string; clientId: string; clientSecret: string; domain: string; required: boolean; autoProvision: boolean }>(null);
  if (!data) return <Loading />;
  const f = form ?? { enabled: data.enabled, issuer: data.issuer, clientId: data.client_id, clientSecret: '', domain: data.domain, required: data.required, autoProvision: data.auto_provision };
  const set = (patch: Partial<typeof f>) => setForm({ ...f, ...patch });
  if (!data.available) {
    return (
      <Callout tone="warning" title="Single sign-on isn’t available on this server">
        It needs the server setting <Kbd>SOFTEX_SECRET_KEY</Kbd> (used to encrypt the provider secret). Ask whoever runs Küü to set it.
      </Callout>
    );
  }
  return (
    <Panel
      className="max-w-3xl"
      title="Single sign-on (OpenID Connect)"
      description="Works with Google Workspace, Microsoft Entra ID, Okta, Auth0, Keycloak and other OIDC providers. Register Küü with your provider using this redirect URI:"
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await act(() => api.put('/admin/sso', { ...f, clientSecret: f.clientSecret || undefined }), 'Single sign-on settings saved');
          if (ok) {
            setForm(null);
            reload();
          }
        }}
      >
        <InputGroup>
          <InputGroupInput readOnly value={data.redirect_uri} aria-label="Redirect URI" className="font-mono text-xs" onFocus={(e) => e.target.select()} />
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="xs" onClick={() => navigator.clipboard?.writeText(data.redirect_uri).then(() => notify('Copied', 'success'))}>
              Copy
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <FormField label="Issuer URL" hint="e.g. https://accounts.google.com or https://login.microsoftonline.com/<tenant>/v2.0">
          <Input required type="url" value={f.issuer} onChange={(e) => set({ issuer: e.target.value })} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Client ID">
            <Input required value={f.clientId} onChange={(e) => set({ clientId: e.target.value })} />
          </FormField>
          <FormField label="Client secret" hint={data.has_client_secret ? 'Leave blank to keep the saved secret.' : undefined}>
            <PasswordInput value={f.clientSecret} onChange={(e) => set({ clientSecret: e.target.value })} placeholder={data.has_client_secret ? '••••••••' : ''} />
          </FormField>
        </div>
        <FormField label="Email domain" hint="People with this email domain are sent to your provider.">
          <Input required value={f.domain} onChange={(e) => set({ domain: e.target.value })} placeholder="acme.com" />
        </FormField>
        <SwitchField label="Enable single sign-on" checked={f.enabled} onCheckedChange={(checked) => set({ enabled: checked })} />
        <SwitchField
          label="Create accounts automatically"
          description="New people from your domain join as members the first time they sign in."
          checked={f.autoProvision}
          onCheckedChange={(checked) => set({ autoProvision: checked })}
        />
        <SwitchField
          label="Require single sign-on"
          description="Password sign-in is turned off for everyone except owners, who keep it as an emergency fallback."
          checked={f.required}
          onCheckedChange={(checked) => set({ required: checked })}
        />
        <div className="flex justify-end">
          <Button type="submit">Save</Button>
        </div>
      </form>
    </Panel>
  );
}

function ScimSettings() {
  const act = useAction();
  const confirm = useConfirm();
  const { data, reload } = useApi<{ enabled: boolean; base_url: string }>('/admin/scim');
  const [token, setToken] = useState<string | null>(null);
  if (!data) return <Loading />;
  return (
    <Panel
      className="max-w-3xl"
      title="User provisioning (SCIM 2.0)"
      description="Let your identity provider (Okta, Microsoft Entra ID, OneLogin, JumpCloud…) create, update and deactivate Küü accounts automatically. Deactivating someone in the provider signs them out everywhere and revokes their API tokens. Owners can never be deactivated through SCIM."
      action={<Pill tone={data.enabled ? 'success' : 'neutral'}>{data.enabled ? 'Enabled' : 'Not set up'}</Pill>}
      contentClassName="flex flex-col gap-4"
    >
      <FormField label="SCIM base URL">
        <Input readOnly value={data.base_url} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
      </FormField>
      {token && <SecretReveal title="Copy this token now. It will not be shown again." value={token} />}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {data.enabled && (
          <Button
            variant="destructive"
            onClick={async () => {
              if (!(await confirm({ title: 'Turn off SCIM provisioning?', description: 'Your identity provider will stop syncing.', confirmLabel: 'Turn off', destructive: true }))) return;
              if (await act(() => api.del('/admin/scim/token'), 'SCIM provisioning turned off')) {
                setToken(null);
                reload();
              }
            }}
          >
            Turn off
          </Button>
        )}
        <Button
          onClick={async () => {
            if (data.enabled && !(await confirm({ title: 'Generate a new token?', description: 'The current one stops working immediately.', confirmLabel: 'Rotate token' }))) return;
            const res = await act(() => api.post<{ token: string }>('/admin/scim/token'));
            if (res) {
              setToken(res.token);
              reload();
            }
          }}
        >
          {data.enabled ? 'Rotate token' : 'Generate token'}
        </Button>
      </div>
    </Panel>
  );
}

function Webhooks() {
  const act = useAction();
  const confirm = useConfirm();
  const { data, reload } = useApi<{
    events: string[];
    webhooks: { id: string; url: string; events: string[]; description: string; active: boolean; recent: { delivered: number | null; failed: number | null; pending: number | null } }[];
  }>('/integrations/webhooks');
  const [form, setForm] = useState({ url: '', description: '', events: [] as string[] });
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const deliveries = useApi<{ id: string; event: string; status: string; attempts: number; response_status: number | null; last_error: string | null; created_at: string }[]>(
    open ? `/integrations/webhooks/${open}/deliveries` : null,
  );
  if (!data) return <Loading />;
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Panel
        title="Webhooks"
        description={
          <>
            Küü POSTs JSON events to these URLs, signed with HMAC-SHA256 in <Kbd>X-Kuu-Signature</Kbd>. Events about private channels, private projects and direct messages are
            never sent.
          </>
        }
        contentClassName="flex flex-col gap-3"
      >
        {!data.webhooks.length && <p className="text-sm text-muted-foreground">No webhooks yet.</p>}
        {data.webhooks.map((w) => (
          <div key={w.id} className="flex flex-col gap-2 rounded-xl border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="min-w-0 flex-1 font-mono text-sm break-all">{w.url}</strong>
              <Pill tone={w.active ? 'success' : 'neutral'}>{w.active ? 'Active' : 'Paused'}</Pill>
            </div>
            <span className="text-xs text-muted-foreground">
              {w.description && `${w.description} · `}
              {w.events.join(', ')} · last 50: {w.recent?.delivered ?? 0} delivered, {w.recent?.failed ?? 0} failed, {w.recent?.pending ?? 0} pending
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setOpen(open === w.id ? null : w.id)} aria-expanded={open === w.id}>
                {open === w.id ? 'Hide deliveries' : 'Deliveries'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  await act(() => api.post(`/integrations/webhooks/${w.id}/ping`), 'Test event queued');
                }}
              >
                Send test
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  await act(() => api.patch(`/integrations/webhooks/${w.id}`, { active: !w.active }));
                  reload();
                }}
              >
                {w.active ? 'Pause' : 'Resume'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const res = await act(() => api.post<{ secret: string }>(`/integrations/webhooks/${w.id}/rotate-secret`), 'Secret rotated');
                  if (res) setSecret(res.secret);
                }}
              >
                Rotate secret
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={async () => {
                  if (!(await confirm({ title: 'Delete this webhook?', confirmLabel: 'Delete', destructive: true }))) return;
                  await act(() => api.del(`/integrations/webhooks/${w.id}`), 'Webhook deleted');
                  reload();
                }}
              >
                Delete
              </Button>
            </div>
            {open === w.id && (
              <Table>
                <TableBody>
                  {(deliveries.data ?? []).map((d) => (
                    <TableRow key={d.id}>
                      <TableCell>{new Date(d.created_at).toLocaleString()}</TableCell>
                      <TableCell>
                        <code className="font-mono text-xs">{d.event}</code>
                      </TableCell>
                      <TableCell>
                        <Pill tone={toneFor(d.status)} className="capitalize">
                          {d.status}
                        </Pill>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {d.response_status ?? ''} {d.last_error ?? ''}
                      </TableCell>
                    </TableRow>
                  ))}
                  {deliveries.data && !deliveries.data.length && (
                    <TableRow>
                      <TableCell className="text-muted-foreground">No deliveries yet.</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </div>
        ))}
        {secret && <SecretReveal title="Signing secret (shown once)" value={secret} />}
      </Panel>
      <Panel title="Add a webhook">
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const res = await act(() => api.post<{ secret: string }>('/integrations/webhooks', form), 'Webhook added');
            if (res) {
              setSecret(res.secret);
              setForm({ url: '', description: '', events: [] });
              reload();
            }
          }}
        >
          <FormField label="Endpoint URL" hint="Must be a public https address.">
            <Input required type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/softex-events" />
          </FormField>
          <FormField label="Description">
            <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </FormField>
          <CheckList
            legend="Events"
            items={['*', ...data.events].map((ev) => ({ id: ev, label: ev === '*' ? 'All events' : ev }))}
            value={form.events}
            onToggle={(ev) => setForm({ ...form, events: form.events.includes(ev) ? form.events.filter((x) => x !== ev) : [...form.events, ev] })}
          />
          <Button disabled={!form.events.length} type="submit" className="self-end">
            Add webhook
          </Button>
        </form>
      </Panel>
    </div>
  );
}

function EmailOutbox() {
  const act = useAction();
  const { data, reload } = useApi<{
    smtp_configured: boolean;
    emails: { id: string; kind: string; to_email: string; subject: string; status: string; attempts: number; last_error: string | null; created_at: string }[];
  }>('/integrations/emails');
  if (!data) return <Loading />;
  return (
    <Panel title="Email" contentClassName="flex flex-col gap-3">
      {!data.smtp_configured && (
        <Callout tone="warning">
          Email delivery is not configured, so messages are recorded here but not sent. Set <Kbd>SOFTEX_SMTP_URL</Kbd> and <Kbd>SOFTEX_MAIL_FROM</Kbd> on the server.
        </Callout>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>To</TableHead>
            <TableHead className="max-md:hidden">Subject</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.emails.map((e) => (
            <TableRow key={e.id}>
              <TableCell>{new Date(e.created_at).toLocaleString()}</TableCell>
              <TableCell>{e.to_email}</TableCell>
              <TableCell className="max-w-sm truncate max-md:hidden">{e.subject}</TableCell>
              <TableCell className="whitespace-normal">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={toneFor(e.status)}>{e.status === 'logged' ? 'not sent' : e.status}</Pill>
                  {e.status === 'failed' && (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={async () => {
                        await act(() => api.post(`/integrations/emails/${e.id}/retry`), 'Queued for another attempt');
                        reload();
                      }}
                    >
                      Retry
                    </Button>
                  )}
                </div>
                {e.last_error && <span className="block text-xs text-muted-foreground">{e.last_error}</span>}
              </TableCell>
            </TableRow>
          ))}
          {!data.emails.length && (
            <TableRow>
              <TableCell className="text-muted-foreground">No emails yet.</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Panel>
  );
}
