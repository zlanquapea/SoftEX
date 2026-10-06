import * as Clipboard from 'expo-clipboard';
import { File } from 'expo-file-system';
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { api, qs, session as apiSession, type Channel, type Me, type Project } from '@/lib/api';
import { pickDocuments, shareApiDownload } from '@/lib/files';
import { dateTime, ROLE_LABEL, timeAgo } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import { BillingSettings } from '@/ui/billing';
import { Icon } from '@/ui/Icon';
import {
  Avatar,
  Button,
  Card,
  Checkbox,
  confirm,
  Empty,
  Field,
  IconButton,
  Input,
  LinkText,
  ListRow,
  Loading,
  Muted,
  PasswordInput,
  Pill,
  Row,
  Screen,
  SearchBox,
  Section,
  Select,
  Sheet,
  T,
  Tabs,
  Toggle,
  useAction,
  useToast,
} from '@/ui/kit';
import { DateField, PeopleField } from '@/ui/pickers';
import { UpgradeNotice, usePlan } from '@/ui/plan';
import { WorkspaceInsights } from '@/ui/planning';

type Tab = 'members' | 'invitations' | 'teams' | 'onboarding' | 'settings' | 'sso' | 'integrations' | 'email' | 'audit' | 'insights' | 'provisioning' | 'billing';

/** A secret shown once, with a copy button. */
function Secret({ title, value }: { title: string; value: string }) {
  const { c } = useTheme();
  const toast = useToast();
  return (
    <View style={{ gap: 8, padding: 12, borderRadius: 12, backgroundColor: c.amberSoft, borderWidth: 1, borderColor: c.amberLine }}>
      <T weight="bold">{title}</T>
      <T size={13} selectable>
        {value}
      </T>
      <Button
        small
        title="Copy"
        onPress={async () => {
          await Clipboard.setStringAsync(value);
          toast('Copied');
        }}
      />
    </View>
  );
}

export default function Admin() {
  const { can, me } = useSession();
  const { has } = usePlan();
  const isAdmin = can('admin');
  const params = useLocalSearchParams<{ tab?: Tab }>();
  const [tab, setTab] = useState<Tab>(params.tab ?? (isAdmin ? 'members' : 'insights'));
  if (!can('lead')) return <Redirect href="/" />;
  const tabs: { id: Tab; label: string }[] = isAdmin
    ? [
        { id: 'members', label: 'Members' },
        ...(me?.mode === 'saas' ? [{ id: 'billing' as Tab, label: 'Billing' }] : []),
        { id: 'insights', label: 'Insights' },
        { id: 'invitations', label: 'Invitations' },
        { id: 'teams', label: 'Teams' },
        { id: 'onboarding', label: 'Onboarding' },
        { id: 'settings', label: 'Workspace' },
        { id: 'sso', label: 'Single sign-on' },
        { id: 'provisioning', label: 'Provisioning' },
        { id: 'integrations', label: 'Webhooks' },
        { id: 'email', label: 'Email' },
        { id: 'audit', label: 'Audit log' },
      ]
    : [
        { id: 'insights', label: 'Insights' },
        { id: 'invitations', label: 'Invitations' },
        { id: 'teams', label: 'Teams' },
      ];
  return (
    <>
      <Stack.Screen options={{ title: 'Administration' }} />
      <Screen>
        <Muted size={14}>People, access, policies and the audit trail.</Muted>
        <Tabs value={tab} onChange={setTab} tabs={tabs} />
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
      </Screen>
    </>
  );
}

// ---------- Members ----------

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
  const { c } = useTheme();
  const { me, reloadPeople } = useSession();
  const act = useAction();
  const { data, reload } = useApi<Member[]>('/admin/members');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Member | null>(null);
  if (!data) return <Loading inline />;
  const update = async (m: Member, patch: Record<string, unknown>, msg: string) => {
    const ok = await act(() => api.patch(`/admin/members/${m.id}`, patch), msg);
    if (ok) {
      reload();
      reloadPeople();
      setEditing(null);
    }
  };
  const list = data.filter((m) => !q || `${m.name} ${m.email}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <SearchBox value={q} onChangeText={setQ} placeholder="Filter members" />
      <Card padded={false} style={{ paddingHorizontal: 14 }}>
        {list.map((m) => (
          <ListRow
            key={m.id}
            style={m.deactivated_at ? { opacity: 0.5 } : undefined}
            left={<Avatar user={m} size="sm" />}
            title={
              <Row gap={6}>
                <T weight="semibold" style={{ flexShrink: 1 }} numberOfLines={1}>
                  {m.name}
                </T>
                {!!m.mfa_enabled && <Icon name="shield" size={13} color={c.green} />}
              </Row>
            }
            subtitle={`${m.email}\n${ROLE_LABEL[m.role]}${m.deactivated_at ? ' · deactivated' : ''} · last sign-in ${m.last_session_at ? timeAgo(m.last_session_at) : '—'}`}
            chevron
            onPress={() => setEditing(m)}
          />
        ))}
      </Card>
      <Sheet open={!!editing} onClose={() => setEditing(null)} title={editing?.name}>
        {editing && (
          <>
            <Muted>{editing.email}</Muted>
            <Field label="Role">
              <Select
                title="Role"
                disabled={!!editing.deactivated_at || (editing.role === 'owner' && me!.role !== 'owner')}
                value={editing.role}
                onChange={(v) => update(editing, { role: v }, 'Role updated')}
                options={Object.entries(ROLE_LABEL)
                  .filter(([r]) => r !== 'owner' || me!.role === 'owner' || editing.role === 'owner')
                  .map(([id, label]) => ({ id, label }))}
              />
            </Field>
            {editing.role === 'guest' && (
              <Field label={`Guest access (sponsor ${editing.sponsor_name ?? '—'})`}>
                <DateField value={editing.guest_expires_at?.slice(0, 10) ?? null} clearable={false} label="Guest access end date" onChange={(v) => v && update(editing, { guestExpiresAt: new Date(`${v}T23:59:59`).toISOString() }, 'Guest access updated')} />
              </Field>
            )}
            <Muted>MFA: {editing.mfa_enabled ? 'Enabled' : 'Off'}</Muted>
            {editing.id !== me!.user.id &&
              (editing.deactivated_at ? (
                <Button title="Reactivate" onPress={() => update(editing, { deactivated: false }, 'Member reactivated')} />
              ) : (
                <Button
                  variant="danger"
                  title="Deactivate"
                  onPress={async () => (await confirm(`Deactivate ${editing.name}?`, 'They will be signed out everywhere immediately.', 'Deactivate')) && update(editing, { deactivated: true }, 'Member deactivated')}
                />
              ))}
          </>
        )}
      </Sheet>
    </>
  );
}

// ---------- Invitations ----------

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
    <Sheet
      open={open}
      onClose={close}
      title="Invite many people"
      full
      footer={
        result ? (
          <Button title="Done" variant="primary" full onPress={close} />
        ) : (
          <Button
            title="Send invitations"
            variant="primary"
            full
            disabled={!text.trim()}
            onPress={async () => {
              const res = await act(() => api.post<{ invited: string[]; skipped: { email: string; reason: string }[] }>('/admin/invitations/bulk', { text, role }));
              if (res) {
                setResult(res);
                onDone();
              }
            }}
          />
        )
      }
    >
      {result ? (
        <>
          <T>
            <T weight="bold">{result.invited.length}</T> invitation{result.invited.length === 1 ? '' : 's'} sent.
          </T>
          {result.skipped.length > 0 && (
            <>
              <Muted>Skipped:</Muted>
              {result.skipped.map((s) => (
                <T key={s.email} size={14}>
                  {s.email} <T size={12} tone="muted">· {s.reason}</T>
                </T>
              ))}
            </>
          )}
        </>
      ) : (
        <>
          <Muted>Paste email addresses (one per line, or separated by commas), or choose a CSV from another tool. Every address found is invited; people who are already members or invited are skipped. Up to 200 at a time.</Muted>
          <Field label="Email addresses">
            <Input multiline value={text} onChangeText={setText} placeholder={'amara@company.com\njoseph@company.com'} autoCapitalize="none" keyboardType="email-address" style={{ minHeight: 160 }} />
          </Field>
          <Button
            icon="file"
            title="Choose a CSV file"
            onPress={() =>
              act(async () => {
                const [f] = await pickDocuments();
                if (f) setText(f.file ? await (f.file as Blob).text() : await new File(f.uri).text());
              })
            }
          />
          <Field label="Role">
            <Select
              title="Role"
              value={role}
              onChange={setRole}
              options={[{ id: 'member', label: 'Member' }, ...(can('admin') ? [{ id: 'lead', label: 'Team lead' }, { id: 'admin', label: 'Admin' }] : [])]}
            />
          </Field>
        </>
      )}
    </Sheet>
  );
}

function Invitations() {
  const { can } = useSession();
  const act = useAction();
  const { data, reload } = useApi<{ id: string; email: string; role: string; guest_days: number | null; expires_at: string; accepted_at: string | null; revoked_at: string | null; created_at: string; invited_by_name: string }[]>('/admin/invitations');
  const { data: channels } = useApi<Channel[]>('/channels');
  const { data: projects } = useApi<Project[]>('/projects');
  const [form, setForm] = useState({ email: '', role: 'member', guestDays: '30', channelIds: [] as string[], projectIds: [] as string[] });
  const [link, setLink] = useState<{ url: string; email: string } | null>(null);
  const [bulk, setBulk] = useState(false);
  const toggle = (key: 'channelIds' | 'projectIds', id: string) => setForm({ ...form, [key]: form[key].includes(id) ? form[key].filter((x) => x !== id) : [...form[key], id] });
  return (
    <>
      <Section title="Invite someone">
        <View style={{ gap: 12 }}>
          <Field label="Email">
            <Input value={form.email} onChangeText={(v) => setForm({ ...form, email: v })} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} />
          </Field>
          <Field label="Role">
            <Select
              title="Role"
              value={form.role}
              onChange={(v) => setForm({ ...form, role: v })}
              options={[{ id: 'member', label: 'Member' }, { id: 'guest', label: 'Guest', hint: 'Partner, limited access' }, ...(can('admin') ? [{ id: 'lead', label: 'Team lead' }, { id: 'admin', label: 'Admin' }] : [])]}
            />
          </Field>
          {form.role === 'guest' && (
            <Field label="Access for (days)">
              <Input value={form.guestDays} onChangeText={(v) => setForm({ ...form, guestDays: v.replace(/\D/g, '') })} keyboardType="number-pad" />
            </Field>
          )}
          <Field label={form.role === 'guest' ? 'Share these channels (required for guests)' : 'Also add to channels'}>
            <View style={{ gap: 8 }}>
              {(channels ?? [])
                .filter((ch) => ch.kind !== 'dm')
                .map((ch) => (
                  <Checkbox key={ch.id} checked={form.channelIds.includes(ch.id)} onChange={() => toggle('channelIds', ch.id)} label={`#${ch.name}`} />
                ))}
            </View>
          </Field>
          <Field label="Projects">
            <View style={{ gap: 8 }}>
              {(projects ?? []).map((p) => (
                <Checkbox key={p.id} checked={form.projectIds.includes(p.id)} onChange={() => toggle('projectIds', p.id)} label={p.name} />
              ))}
            </View>
          </Field>
          <Button
            variant="primary"
            title="Create invitation"
            disabled={!form.email.includes('@')}
            onPress={async () => {
              const res = await act(() => api.post<{ url: string }>('/admin/invitations', { ...form, guestDays: form.role === 'guest' ? Number(form.guestDays) || 30 : undefined }));
              if (res) {
                setLink({ url: `${apiSession.server}${res.url}`, email: form.email });
                setForm({ email: '', role: form.role, guestDays: '30', channelIds: [], projectIds: [] });
                reload();
              }
            }}
          />
          <Button title="Invite many people at once" onPress={() => setBulk(true)} />
          {link && <Secret title={`Invitation emailed to ${link.email}. You can also share this link directly (valid for 14 days, shown only once):`} value={link.url} />}
        </View>
      </Section>
      <BulkInvite open={bulk} onClose={() => setBulk(false)} onDone={reload} />
      <Section title="Invitations">
        {!data && <Loading inline />}
        {data && !data.length && <Muted>No invitations yet.</Muted>}
        {data?.map((i) => {
          const state = i.accepted_at ? 'Accepted' : i.revoked_at ? 'Revoked' : new Date(i.expires_at) < new Date() ? 'Expired' : 'Pending';
          return (
            <ListRow
              key={i.id}
              title={
                <Row gap={6}>
                  <T weight="semibold" style={{ flexShrink: 1 }} numberOfLines={1}>
                    {i.email}
                  </T>
                  <Pill label={ROLE_LABEL[i.role]} />
                </Row>
              }
              subtitle={`${state} · invited by ${i.invited_by_name} ${timeAgo(i.created_at)}`}
              right={
                <Row gap={4}>
                  {(state === 'Pending' || state === 'Expired') && (
                    <Button
                      small
                      title="Resend"
                      onPress={async () => {
                        const res = await act(() => api.post<{ url: string }>(`/admin/invitations/${i.id}/resend`), `Invitation re-sent to ${i.email}`);
                        if (res) {
                          setLink({ url: `${apiSession.server}${res.url}`, email: i.email });
                          reload();
                        }
                      }}
                    />
                  )}
                  {state === 'Pending' && (
                    <Button
                      small
                      title="Revoke"
                      onPress={async () => {
                        await act(() => api.del(`/admin/invitations/${i.id}`), 'Invitation revoked');
                        reload();
                      }}
                    />
                  )}
                </Row>
              }
            />
          );
        })}
      </Section>
    </>
  );
}

// ---------- Teams & onboarding ----------

function Teams() {
  const { c } = useTheme();
  const { can } = useSession();
  const act = useAction();
  const { data, reload } = useApi<{ id: string; name: string; description: string; members: { id: string; name: string; color: string }[] }[]>('/teams');
  const [form, setForm] = useState({ name: '', description: '', memberIds: [] as string[] });
  return (
    <>
      <Section title="Teams">
        {!data && <Loading inline />}
        {data && !data.length && <Empty icon="users" title="No teams yet" />}
        {data?.map((t) => (
          <View key={t.id} style={{ gap: 6, paddingVertical: 10, borderTopWidth: 1, borderColor: c.line2 }}>
            <Row>
              <T weight="bold" style={{ flex: 1 }}>
                {t.name}
              </T>
              {can('admin') && (
                <IconButton
                  name="trash"
                  size={16}
                  label={`Delete ${t.name}`}
                  onPress={async () => {
                    if (!(await confirm(`Delete team ${t.name}?`, undefined, 'Delete'))) return;
                    await act(() => api.del(`/teams/${t.id}`), 'Team deleted');
                    reload();
                  }}
                />
              )}
            </Row>
            {!!t.description && <Muted size={13}>{t.description}</Muted>}
            <PeopleField
              title={`${t.name} members`}
              value={t.members.map((m) => m.id)}
              onChange={async (ids) => {
                await act(() => api.patch(`/teams/${t.id}`, { memberIds: ids }), 'Team updated');
                reload();
              }}
            />
          </View>
        ))}
      </Section>
      <Section title="New team">
        <View style={{ gap: 12 }}>
          <Field label="Name">
            <Input value={form.name} onChangeText={(v) => setForm({ ...form, name: v })} />
          </Field>
          <Field label="Description">
            <Input value={form.description} onChangeText={(v) => setForm({ ...form, description: v })} />
          </Field>
          <Field label="Members">
            <PeopleField value={form.memberIds} onChange={(ids) => setForm({ ...form, memberIds: ids })} title="Members" />
          </Field>
          <Button
            variant="primary"
            title="Create team"
            disabled={!form.name.trim()}
            onPress={async () => {
              const ok = await act(() => api.post('/teams', form), 'Team created');
              if (ok) {
                setForm({ name: '', description: '', memberIds: [] });
                reload();
              }
            }}
          />
        </View>
      </Section>
    </>
  );
}

function OnboardingAdmin() {
  const { c } = useTheme();
  const act = useAction();
  const { data, reload } = useApi<{ id: string; title: string; description: string; link: string; role: string | null }[]>('/onboarding/items');
  const [form, setForm] = useState({ title: '', description: '', link: '', role: '' });
  return (
    <>
      <Section title="Onboarding checklist">
        <Muted style={{ marginBottom: 6 }}>New members see these steps on Home until they complete them.</Muted>
        {data?.map((i) => (
          <ListRow
            key={i.id}
            left={<Icon name="flag" size={17} color={c.ink2} />}
            title={
              <Row gap={6}>
                <T weight="semibold" style={{ flexShrink: 1 }}>
                  {i.title}
                </T>
                {i.role && <Pill label={`${ROLE_LABEL[i.role]} only`} />}
              </Row>
            }
            subtitle={i.description || undefined}
            right={
              <IconButton
                name="x"
                size={14}
                label={`Remove ${i.title}`}
                onPress={async () => {
                  await act(() => api.del(`/onboarding/items/${i.id}`));
                  reload();
                }}
              />
            }
          />
        ))}
        {data && !data.length && <Muted>No steps yet.</Muted>}
      </Section>
      <Section title="Add a step">
        <View style={{ gap: 12 }}>
          <Field label="Title">
            <Input value={form.title} onChangeText={(v) => setForm({ ...form, title: v })} placeholder="e.g. Read the handbook" />
          </Field>
          <Field label="Description">
            <Input value={form.description} onChangeText={(v) => setForm({ ...form, description: v })} />
          </Field>
          <Field label="Link (optional)" hint="A knowledge page like /knowledge/… or an external URL.">
            <Input value={form.link} onChangeText={(v) => setForm({ ...form, link: v })} autoCapitalize="none" />
          </Field>
          <Field label="For">
            <Select title="For" value={form.role} onChange={(v) => setForm({ ...form, role: v })} options={[{ id: '', label: 'Everyone' }, ...Object.entries(ROLE_LABEL).map(([id, l]) => ({ id, label: `${l}s` }))]} />
          </Field>
          <Button
            variant="primary"
            title="Add step"
            disabled={!form.title.trim()}
            onPress={async () => {
              const ok = await act(() => api.post('/onboarding/items', { ...form, role: form.role || null }), 'Step added');
              if (ok) {
                setForm({ title: '', description: '', link: '', role: '' });
                reload();
              }
            }}
          />
        </View>
      </Section>
    </>
  );
}

// ---------- Workspace ----------

function WorkspaceSettings() {
  const { me, refresh } = useSession();
  const act = useAction();
  const { has } = usePlan();
  const ws = me!.workspace;
  const [form, setForm] = useState({
    name: ws.name,
    messageEditPolicy: ws.message_edit_policy,
    guestDefaultDays: String(ws.guest_default_days),
    requireMfa: ws.require_mfa,
    aiEnabled: ws.ai_enabled,
    retentionDays: ws.retention_days as number | null,
    legalHold: ws.legal_hold,
  });
  return (
    <>
      <Section title="Workspace">
        <View style={{ gap: 12 }}>
          <Field label="Workspace name">
            <Input value={form.name} onChangeText={(v) => setForm({ ...form, name: v })} />
          </Field>
          <Field label="Message editing and deletion">
            <Select
              title="Message editing and deletion"
              value={form.messageEditPolicy}
              onChange={(v) => setForm({ ...form, messageEditPolicy: v })}
              options={[
                { id: 'author', label: 'Authors can edit and delete their messages' },
                { id: 'admins', label: 'Only admins can edit or delete' },
                { id: 'none', label: 'No editing (admins can still delete)' },
              ]}
            />
          </Field>
          <Field label="Default guest access (days)">
            <Input value={form.guestDefaultDays} onChangeText={(v) => setForm({ ...form, guestDefaultDays: v.replace(/\D/g, '') })} keyboardType="number-pad" />
          </Field>
          <Toggle label="Require multifactor authentication" hint="Members without MFA must set it up before they can continue." value={form.requireMfa} onChange={(v) => setForm({ ...form, requireMfa: v })} />
          <Toggle
            label="AI assistance"
            disabled={!ws.ai_available || !has('ai')}
            hint={
              !has('ai')
                ? 'Available on the Organization plan.'
                : ws.ai_available
                  ? 'Drafts thread and meeting summaries, task suggestions and project briefs. It only reads content the requesting person can already open, every use is audited, and spaces can be excluded.'
                  : 'Not available: the server administrator must set ANTHROPIC_API_KEY first.'
            }
            value={form.aiEnabled && has('ai')}
            onChange={(v) => setForm({ ...form, aiEnabled: v })}
          />
          <T weight="display" size={16}>
            Retention
          </T>
          {!has('retention') && <UpgradeNotice feature="retention" />}
          <Field label="Keep messages for" hint="Older messages are deleted automatically (a thread is kept while it has recent replies). Knowledge pages, decisions, tasks and library files are kept.">
            <Select
              title="Keep messages for"
              disabled={!has('retention')}
              value={form.retentionDays == null ? '' : String(form.retentionDays)}
              onChange={(v) => setForm({ ...form, retentionDays: v ? Number(v) : null })}
              options={[{ id: '', label: 'Forever' }, ...[30, 90, 180, 365, 730, 1095, 1825, 2555, 3650].map((d) => ({ id: String(d), label: d < 365 ? `${d} days` : `${Math.round(d / 365)} year${d >= 730 ? 's' : ''}` }))]}
            />
          </Field>
          <Toggle label="Legal hold" hint="Pauses all automatic deletion while an investigation or litigation is underway. Changes are recorded in the audit log." disabled={!has('retention')} value={form.legalHold} onChange={(v) => setForm({ ...form, legalHold: v })} />
          <Button
            variant="primary"
            title="Save settings"
            disabled={!form.name.trim()}
            onPress={async () => {
              const { aiEnabled, retentionDays, legalHold, guestDefaultDays, ...rest } = form;
              const payload = { ...rest, guestDefaultDays: Number(guestDefaultDays) || 30, ...(has('ai') ? { aiEnabled } : {}), ...(has('retention') ? { retentionDays, legalHold } : {}) };
              const ok = await act(() => api.patch('/admin/workspace', payload), 'Workspace settings saved');
              if (ok) refresh();
            }}
          />
          <Button icon="download" title="Export data" onPress={() => act(() => shareApiDownload('/export', 'kuu-export.json', 'application/json'))} />
        </View>
      </Section>
      {me!.role === 'owner' && <DeleteWorkspace />}
    </>
  );
}

function DeleteWorkspace() {
  const { c } = useTheme();
  const { me, setMe } = useSession();
  const act = useAction();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ confirmName: '', password: '', code: '' });
  const name = me!.workspace.name;
  return (
    <Card style={{ gap: 10, borderColor: c.redLine }}>
      <T size={17} weight="display" tone="red">
        Delete workspace
      </T>
      <Muted>Permanently deletes {name} for everyone: messages, files, tasks, projects, knowledge, meetings and settings. This can't be undone. Export your data first if you may need it.</Muted>
      <Button variant="danger" title="Delete this workspace" onPress={() => setOpen(true)} />
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={`Delete ${name}?`}
        eyebrow="Danger"
        footer={
          <Button
            variant="danger"
            full
            title="Delete forever"
            disabled={form.confirmName.trim() !== name || !form.password}
            onPress={async () => {
              const res = await act(() => api.del<{ me: Me | null }>('/admin/workspace', { ...form, code: form.code || undefined }));
              if (res) setMe(res.me);
            }}
          />
        }
      >
        <T>
          Everything in <T weight="bold">{name}</T> will be deleted, and all {me!.workspace.member_count} members lose access immediately.
        </T>
        <Field label={`Type the workspace name (${name}) to confirm`}>
          <Input value={form.confirmName} onChangeText={(v) => setForm({ ...form, confirmName: v })} autoCorrect={false} />
        </Field>
        <Field label="Your password">
          <PasswordInput value={form.password} onChangeText={(v) => setForm({ ...form, password: v })} />
        </Field>
        {me!.user.mfa_enabled && (
          <Field label="Authenticator code">
            <Input value={form.code} onChangeText={(v) => setForm({ ...form, code: v })} keyboardType="number-pad" textContentType="oneTimeCode" />
          </Field>
        )}
      </Sheet>
    </Card>
  );
}

// ---------- SSO, SCIM, webhooks, email, audit ----------

function SsoSettings() {
  const act = useAction();
  const { data, reload } = useApi<{ available: boolean; enabled: boolean; issuer: string; client_id: string; has_client_secret: boolean; domain: string; required: boolean; auto_provision: boolean; redirect_uri: string }>('/admin/sso');
  const [form, setForm] = useState<null | { enabled: boolean; issuer: string; clientId: string; clientSecret: string; domain: string; required: boolean; autoProvision: boolean }>(null);
  if (!data) return <Loading inline />;
  if (!data.available) return <Muted>Single sign-on needs the server setting SOFTEX_SECRET_KEY (used to encrypt the provider secret). Ask whoever runs Küü to set it.</Muted>;
  const f = form ?? { enabled: data.enabled, issuer: data.issuer, clientId: data.client_id, clientSecret: '', domain: data.domain, required: data.required, autoProvision: data.auto_provision };
  const set = (patch: Partial<typeof f>) => setForm({ ...f, ...patch });
  return (
    <Section title="Single sign-on (OpenID Connect)">
      <View style={{ gap: 12 }}>
        <Muted>Works with Google Workspace, Microsoft Entra ID, Okta, Auth0, Keycloak and other OIDC providers. Register Küü with your provider using this redirect URI:</Muted>
        <T size={13} selectable>
          {data.redirect_uri}
        </T>
        <Field label="Issuer URL" hint="e.g. https://accounts.google.com">
          <Input value={f.issuer} onChangeText={(v) => set({ issuer: v })} keyboardType="url" autoCapitalize="none" />
        </Field>
        <Field label="Client ID">
          <Input value={f.clientId} onChangeText={(v) => set({ clientId: v })} autoCapitalize="none" />
        </Field>
        <Field label="Client secret" hint={data.has_client_secret ? 'Leave blank to keep the saved secret.' : undefined}>
          <PasswordInput value={f.clientSecret} onChangeText={(v) => set({ clientSecret: v })} placeholder={data.has_client_secret ? '••••••••' : ''} />
        </Field>
        <Field label="Email domain" hint="People with this email domain are sent to your provider.">
          <Input value={f.domain} onChangeText={(v) => set({ domain: v })} placeholder="acme.com" autoCapitalize="none" />
        </Field>
        <Toggle label="Enable single sign-on" value={f.enabled} onChange={(v) => set({ enabled: v })} />
        <Toggle label="Create accounts automatically" hint="New people from your domain join as members the first time they sign in." value={f.autoProvision} onChange={(v) => set({ autoProvision: v })} />
        <Toggle label="Require single sign-on" hint="Password sign-in is turned off for everyone except owners, who keep it as an emergency fallback." value={f.required} onChange={(v) => set({ required: v })} />
        <Button
          variant="primary"
          title="Save"
          onPress={async () => {
            const ok = await act(() => api.put('/admin/sso', { ...f, clientSecret: f.clientSecret || undefined }), 'Single sign-on settings saved');
            if (ok) {
              setForm(null);
              reload();
            }
          }}
        />
      </View>
    </Section>
  );
}

function ScimSettings() {
  const act = useAction();
  const { data, reload } = useApi<{ enabled: boolean; base_url: string }>('/admin/scim');
  const [token, setToken] = useState<string | null>(null);
  if (!data) return <Loading inline />;
  return (
    <Section title="User provisioning (SCIM 2.0)">
      <View style={{ gap: 12 }}>
        <Muted>
          Let your identity provider (Okta, Microsoft Entra ID, OneLogin, JumpCloud…) create, update and deactivate Küü accounts automatically. Deactivating someone in the provider signs them out everywhere and revokes their API tokens. Owners can never be deactivated through SCIM.
        </Muted>
        <Field label="SCIM base URL">
          <T size={13} selectable>
            {data.base_url}
          </T>
        </Field>
        <T>
          Status: <T weight="bold">{data.enabled ? 'Enabled' : 'Not set up'}</T>
        </T>
        {token && <Secret title="Copy this token now. It will not be shown again." value={token} />}
        <Row>
          {data.enabled && (
            <Button
              variant="danger"
              title="Turn off"
              onPress={async () => {
                if (!(await confirm('Turn off SCIM provisioning?', 'Your identity provider will stop syncing.', 'Turn off'))) return;
                if (await act(() => api.del('/admin/scim/token'), 'SCIM provisioning turned off')) {
                  setToken(null);
                  reload();
                }
              }}
            />
          )}
          <Button
            variant="primary"
            title={data.enabled ? 'Rotate token' : 'Generate token'}
            onPress={async () => {
              if (data.enabled && !(await confirm('Generate a new token?', 'The current one stops working immediately.', 'Rotate'))) return;
              const res = await act(() => api.post<{ token: string }>('/admin/scim/token'));
              if (res) {
                setToken(res.token);
                reload();
              }
            }}
          />
        </Row>
      </View>
    </Section>
  );
}

function Webhooks() {
  const { c } = useTheme();
  const act = useAction();
  const { data, reload } = useApi<{ events: string[]; webhooks: { id: string; url: string; events: string[]; description: string; active: boolean; recent: { delivered: number | null; failed: number | null; pending: number | null } }[] }>('/integrations/webhooks');
  const [form, setForm] = useState({ url: '', description: '', events: [] as string[] });
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const deliveries = useApi<{ id: string; event: string; status: string; attempts: number; response_status: number | null; last_error: string | null; created_at: string }[]>(open ? `/integrations/webhooks/${open}/deliveries` : null);
  if (!data) return <Loading inline />;
  return (
    <>
      <Section title="Webhooks">
        <Muted style={{ marginBottom: 6 }}>Küü POSTs JSON events to these URLs, signed with HMAC-SHA256 in X-Kuu-Signature. Events about private channels, private projects and direct messages are never sent.</Muted>
        {!data.webhooks.length && <Muted>No webhooks yet.</Muted>}
        {data.webhooks.map((w) => (
          <View key={w.id} style={{ gap: 6, paddingVertical: 10, borderTopWidth: 1, borderColor: c.line2 }}>
            <Row style={{ alignItems: 'flex-start' }}>
              <T weight="bold" style={{ flex: 1 }} selectable>
                {w.url}
              </T>
              <Pill label={w.active ? 'Active' : 'Paused'} tone={w.active ? 'green' : 'neutral'} />
            </Row>
            <Muted size={12}>
              {w.description ? `${w.description} · ` : ''}
              {w.events.join(', ')} · last 50: {w.recent?.delivered ?? 0} delivered, {w.recent?.failed ?? 0} failed, {w.recent?.pending ?? 0} pending
            </Muted>
            <Row wrap>
              <Button small title={open === w.id ? 'Hide deliveries' : 'Deliveries'} onPress={() => setOpen(open === w.id ? null : w.id)} />
              <Button small title="Send test" onPress={() => act(() => api.post(`/integrations/webhooks/${w.id}/ping`), 'Test event queued')} />
              <Button
                small
                title={w.active ? 'Pause' : 'Resume'}
                onPress={async () => {
                  await act(() => api.patch(`/integrations/webhooks/${w.id}`, { active: !w.active }));
                  reload();
                }}
              />
              <Button
                small
                title="Rotate secret"
                onPress={async () => {
                  const res = await act(() => api.post<{ secret: string }>(`/integrations/webhooks/${w.id}/rotate-secret`), 'Secret rotated');
                  if (res) setSecret(res.secret);
                }}
              />
              <Button
                small
                variant="danger"
                title="Delete"
                onPress={async () => {
                  if (!(await confirm('Delete this webhook?', undefined, 'Delete'))) return;
                  await act(() => api.del(`/integrations/webhooks/${w.id}`), 'Webhook deleted');
                  reload();
                }}
              />
            </Row>
            {open === w.id &&
              (deliveries.data ?? []).map((d) => (
                <ListRow
                  key={d.id}
                  title={d.event}
                  subtitle={`${new Date(d.created_at).toLocaleString()}${d.response_status ? ` · ${d.response_status}` : ''}${d.last_error ? ` · ${d.last_error}` : ''}`}
                  right={<Pill label={d.status} tone={d.status === 'delivered' ? 'green' : d.status === 'failed' ? 'red' : 'neutral'} />}
                />
              ))}
            {open === w.id && deliveries.data && !deliveries.data.length && <Muted>No deliveries yet.</Muted>}
          </View>
        ))}
        {secret && <Secret title="Signing secret (shown once):" value={secret} />}
      </Section>
      <Section title="Add a webhook">
        <View style={{ gap: 12 }}>
          <Field label="Endpoint URL" hint="Must be a public https address.">
            <Input value={form.url} onChangeText={(v) => setForm({ ...form, url: v })} placeholder="https://example.com/softex-events" keyboardType="url" autoCapitalize="none" />
          </Field>
          <Field label="Description">
            <Input value={form.description} onChangeText={(v) => setForm({ ...form, description: v })} />
          </Field>
          <Field label="Events">
            <View style={{ gap: 8 }}>
              {['*', ...data.events].map((ev) => (
                <Checkbox key={ev} checked={form.events.includes(ev)} onChange={() => setForm({ ...form, events: form.events.includes(ev) ? form.events.filter((x) => x !== ev) : [...form.events, ev] })} label={ev === '*' ? 'All events' : ev} />
              ))}
            </View>
          </Field>
          <Button
            variant="primary"
            title="Add webhook"
            disabled={!form.events.length || !/^https:\/\//.test(form.url)}
            onPress={async () => {
              const res = await act(() => api.post<{ secret: string }>('/integrations/webhooks', form), 'Webhook added');
              if (res) {
                setSecret(res.secret);
                setForm({ url: '', description: '', events: [] });
                reload();
              }
            }}
          />
        </View>
      </Section>
    </>
  );
}

function EmailOutbox() {
  const { c } = useTheme();
  const act = useAction();
  const { data, reload } = useApi<{ smtp_configured: boolean; emails: { id: string; kind: string; to_email: string; subject: string; status: string; attempts: number; last_error: string | null; created_at: string }[] }>('/integrations/emails');
  if (!data) return <Loading inline />;
  return (
    <Section title="Email">
      {!data.smtp_configured && (
        <View style={{ padding: 12, borderRadius: 12, backgroundColor: c.amberSoft, marginBottom: 8 }}>
          <T size={14} tone="amber">
            Email delivery is not configured, so messages are recorded here but not sent. Set SOFTEX_SMTP_URL and SOFTEX_MAIL_FROM on the server.
          </T>
        </View>
      )}
      {data.emails.map((e) => (
        <ListRow
          key={e.id}
          title={e.subject}
          subtitle={`${e.to_email} · ${new Date(e.created_at).toLocaleString()}${e.last_error ? `\n${e.last_error}` : ''}`}
          right={
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <Pill label={e.status === 'logged' ? 'not sent' : e.status} tone={e.status === 'sent' ? 'green' : e.status === 'failed' ? 'red' : 'neutral'} />
              {e.status === 'failed' && (
                <LinkText
                  size={12}
                  onPress={async () => {
                    await act(() => api.post(`/integrations/emails/${e.id}/retry`), 'Queued for another attempt');
                    reload();
                  }}
                >
                  Retry
                </LinkText>
              )}
            </View>
          }
        />
      ))}
      {!data.emails.length && <Muted>No emails yet.</Muted>}
    </Section>
  );
}

function Audit() {
  const [action, setAction] = useState('');
  const { data } = useApi<{ id: string; action: string; actor_name: string | null; target_type: string; target_id: string; detail: Record<string, unknown>; created_at: string }[]>(`/admin/audit${qs({ action, limit: 200 })}`);
  const row = (e: NonNullable<typeof data>[number]): ReactNode => (
    <ListRow
      key={e.id}
      title={
        <T size={13} weight="bold">
          {e.action}
        </T>
      }
      subtitle={`${e.actor_name ?? 'System'} · ${dateTime(e.created_at)}${Object.keys(e.detail).length ? `\n${Object.entries(e.detail)
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' · ')}` : ''}`}
    />
  );
  return (
    <>
      <Select
        title="Filter by action"
        value={action}
        onChange={setAction}
        options={[
          { id: '', label: 'All events' },
          { id: 'auth', label: 'Sign-ins' },
          { id: 'member', label: 'Member changes' },
          { id: 'invitation', label: 'Invitations' },
          { id: 'guest', label: 'Guest access' },
          { id: 'project', label: 'Projects' },
          { id: 'channel', label: 'Channels' },
          { id: 'file', label: 'Files' },
          { id: 'workspace', label: 'Workspace settings' },
          { id: 'data', label: 'Exports' },
        ]}
      />
      <Card padded={false} style={{ paddingHorizontal: 14 }}>
        {!data ? <Loading inline /> : data.length ? data.map(row) : <Muted style={{ paddingVertical: 12 }}>No events.</Muted>}
      </Card>
    </>
  );
}
