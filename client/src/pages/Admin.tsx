import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs, type Channel, type Me, type Project } from '../api';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { WorkspaceInsights } from './Planning';
import { BillingSettings } from './Billing';
import { UpgradeNotice, usePlan } from '../components/Plan';
import { Empty, Field, Loading, Modal, PeoplePicker, Tabs, useAction } from '../components/ui';
import { dateTime, ROLE_LABEL, timeAgo } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';

type Tab = 'members' | 'invitations' | 'teams' | 'onboarding' | 'settings' | 'sso' | 'integrations' | 'email' | 'audit' | 'insights' | 'provisioning' | 'billing';

export function Admin() {
  const { can, me } = useSession();
  const { has } = usePlan();
  const [params, setParams] = useSearchParams();
  const isAdmin = can('admin');
  const tab = (params.get('tab') as Tab) ?? (isAdmin ? 'members' : 'insights');
  if (!can('lead')) return <Navigate to="/" replace />;
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
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Administration</h1>
          <p className="muted">People, access, policies and the audit trail.</p>
        </div>
      </div>
      <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={tabs} />
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
    </div>
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
    <div className="card">
      <input className="filter" placeholder="Filter members" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter members" />
      <table className="table">
        <thead>
          <tr>
            <th>Person</th>
            <th>Role</th>
            <th className="hide-mobile">MFA</th>
            <th className="hide-mobile">Last sign-in</th>
            <th>Access</th>
          </tr>
        </thead>
        <tbody>
          {list.map((m) => (
            <tr key={m.id} className={m.deactivated_at ? 'muted-row' : ''}>
              <td>
                <div className="row-gap">
                  <Avatar user={m} size="sm" />
                  <div>
                    <strong>{m.name}</strong>
                    <small className="muted block">{m.email}</small>
                  </div>
                </div>
              </td>
              <td>
                <select
                  value={m.role}
                  disabled={!!m.deactivated_at || (m.role === 'owner' && me!.role !== 'owner')}
                  onChange={(e) => update(m, { role: e.target.value }, 'Role updated')}
                  aria-label={`Role for ${m.name}`}
                >
                  {Object.entries(ROLE_LABEL)
                    .filter(([r]) => r !== 'owner' || me!.role === 'owner' || m.role === 'owner')
                    .map(([r, label]) => (
                      <option key={r} value={r}>
                        {label}
                      </option>
                    ))}
                </select>
                {m.role === 'guest' && (
                  <small className="block muted">
                    Sponsor {m.sponsor_name ?? '—'} · until{' '}
                    <input
                      type="date"
                      value={m.guest_expires_at?.slice(0, 10) ?? ''}
                      onChange={(e) => e.target.value && update(m, { guestExpiresAt: new Date(`${e.target.value}T23:59:59`).toISOString() }, 'Guest access updated')}
                      aria-label="Guest access end date"
                    />
                  </small>
                )}
              </td>
              <td className="hide-mobile">{m.mfa_enabled ? <Icon name="shield" size={16} label="Enabled" /> : <span className="muted">Off</span>}</td>
              <td className="hide-mobile">{m.last_session_at ? timeAgo(m.last_session_at) : '—'}</td>
              <td>
                {m.id !== me!.user.id &&
                  (m.deactivated_at ? (
                    <button className="btn sm" onClick={() => update(m, { deactivated: false }, 'Member reactivated')}>
                      Reactivate
                    </button>
                  ) : (
                    <button
                      className="btn sm danger-text"
                      onClick={() => confirm(`Deactivate ${m.name}? They will be signed out everywhere immediately.`) && update(m, { deactivated: true }, 'Member deactivated')}
                    >
                      Deactivate
                    </button>
                  ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
  const toggle = (key: 'channelIds' | 'projectIds', id: string) =>
    setForm({ ...form, [key]: form[key].includes(id) ? form[key].filter((x) => x !== id) : [...form[key], id] });
  return (
    <div className="two-col">
      <form
        className="card form"
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
        <h2>Invite someone</h2>
        <Field label="Email">
          <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <div className="form-row">
          <Field label="Role">
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="member">Member</option>
              <option value="guest">Guest (partner, limited access)</option>
              {can('admin') && <option value="lead">Team lead</option>}
              {can('admin') && <option value="admin">Admin</option>}
            </select>
          </Field>
          {form.role === 'guest' && (
            <Field label="Access for (days)">
              <input type="number" min={1} max={365} value={form.guestDays} onChange={(e) => setForm({ ...form, guestDays: Number(e.target.value) })} />
            </Field>
          )}
        </div>
        <Field label={form.role === 'guest' ? 'Share these channels (required for guests)' : 'Also add to channels'}>
          <div className="check-list">
            {(channels ?? [])
              .filter((c) => c.kind !== 'dm')
              .map((c) => (
                <label key={c.id} className="check-inline">
                  <input type="checkbox" checked={form.channelIds.includes(c.id)} onChange={() => toggle('channelIds', c.id)} /> #{c.name}
                </label>
              ))}
          </div>
        </Field>
        <Field label="Projects">
          <div className="check-list">
            {(projects ?? []).map((p) => (
              <label key={p.id} className="check-inline">
                <input type="checkbox" checked={form.projectIds.includes(p.id)} onChange={() => toggle('projectIds', p.id)} /> {p.name}
              </label>
            ))}
          </div>
        </Field>
        <button className="btn primary">Create invitation</button>
        {link && (
          <div className="hint-box">
            <p>
              Invitation emailed to <strong>{link.email}</strong>. You can also share this link directly (valid for 14 days, shown only once):
            </p>
            <code className="secret">{link.url}</code>
            <button type="button" className="btn sm" onClick={() => navigator.clipboard?.writeText(link.url)}>
              Copy link
            </button>
          </div>
        )}
      </form>
      <div className="card">
        <h2>Invitations</h2>
        {!data && <Loading />}
        {data && !data.length && <p className="muted">No invitations yet.</p>}
        {data?.map((i) => {
          const state = i.accepted_at ? 'Accepted' : i.revoked_at ? 'Revoked' : new Date(i.expires_at) < new Date() ? 'Expired' : 'Pending';
          return (
            <div key={i.id} className="list-row">
              <span className="grow">
                <strong>{i.email}</strong> <span className="pill">{ROLE_LABEL[i.role]}</span>
                <small className="muted block">
                  {state} · invited by {i.invited_by_name} {timeAgo(i.created_at)}
                </small>
              </span>
              {(state === 'Pending' || state === 'Expired') && (
                <button
                  className="btn sm"
                  onClick={async () => {
                    const res = await act(() => api.post<{ url: string }>(`/admin/invitations/${i.id}/resend`), `Invitation re-sent to ${i.email}`);
                    if (res) {
                      setLink({ url: `${location.origin}${res.url}`, email: i.email });
                      reload();
                    }
                  }}
                >
                  Resend
                </button>
              )}
              {state === 'Pending' && (
                <button
                  className="btn sm"
                  onClick={async () => {
                    await act(() => api.del(`/admin/invitations/${i.id}`), 'Invitation revoked');
                    reload();
                  }}
                >
                  Revoke
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Teams() {
  const { people, can } = useSession();
  const act = useAction();
  const { data, reload } = useApi<{ id: string; name: string; description: string; members: { id: string; name: string; color: string }[] }[]>('/teams');
  const [form, setForm] = useState({ name: '', description: '', memberIds: [] as string[] });
  const [editing, setEditing] = useState<string | null>(null);
  const [editIds, setEditIds] = useState<string[]>([]);
  return (
    <div className="two-col">
      <div className="card">
        <h2>Teams</h2>
        {!data && <Loading />}
        {data && !data.length && <Empty icon="users" title="No teams yet" />}
        {data?.map((t) => (
          <div key={t.id} className="team-row">
            <div className="row-gap">
              <strong className="grow">{t.name}</strong>
              <button
                className="link-btn"
                onClick={() => {
                  setEditing(editing === t.id ? null : t.id);
                  setEditIds(t.members.map((m) => m.id));
                }}
              >
                {editing === t.id ? 'Close' : 'Edit members'}
              </button>
              {can('admin') && (
                <button
                  className="icon-btn xs"
                  aria-label={`Delete ${t.name}`}
                  onClick={async () => {
                    if (!confirm(`Delete team ${t.name}?`)) return;
                    await act(() => api.del(`/teams/${t.id}`), 'Team deleted');
                    reload();
                  }}
                >
                  <Icon name="trash" size={14} />
                </button>
              )}
            </div>
            {t.description && <small className="muted">{t.description}</small>}
            {editing === t.id ? (
              <div className="form">
                <PeoplePicker people={people} value={editIds} onChange={setEditIds} />
                <button
                  className="btn primary sm"
                  onClick={async () => {
                    await act(() => api.patch(`/teams/${t.id}`, { memberIds: editIds }), 'Team updated');
                    setEditing(null);
                    reload();
                  }}
                >
                  Save members
                </button>
              </div>
            ) : (
              <div className="chips">
                {t.members.map((m) => (
                  <span key={m.id} className="chip">
                    <Avatar user={m} size="xs" /> {m.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <form
        className="card form"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await act(() => api.post('/teams', form), 'Team created');
          if (ok) {
            setForm({ name: '', description: '', memberIds: [] });
            reload();
          }
        }}
      >
        <h2>New team</h2>
        <Field label="Name">
          <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Description">
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field label="Members">
          <PeoplePicker people={people} value={form.memberIds} onChange={(ids) => setForm({ ...form, memberIds: ids })} />
        </Field>
        <button className="btn primary">Create team</button>
      </form>
    </div>
  );
}

function OnboardingAdmin() {
  const act = useAction();
  const { data, reload } = useApi<{ id: string; title: string; description: string; link: string; role: string | null }[]>('/onboarding/items');
  const [form, setForm] = useState({ title: '', description: '', link: '', role: '' });
  return (
    <div className="two-col">
      <div className="card">
        <h2>Onboarding checklist</h2>
        <p className="muted">New members see these steps on Home until they complete them.</p>
        {data?.map((i) => (
          <div key={i.id} className="list-row">
            <Icon name="flag" />
            <span className="grow">
              <strong>{i.title}</strong> {i.role && <span className="pill">{ROLE_LABEL[i.role]} only</span>}
              {i.description && <small className="muted block">{i.description}</small>}
            </span>
            <button
              className="icon-btn xs"
              aria-label={`Remove ${i.title}`}
              onClick={async () => {
                await act(() => api.del(`/onboarding/items/${i.id}`));
                reload();
              }}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
        {data && !data.length && <p className="muted">No steps yet.</p>}
      </div>
      <form
        className="card form"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await act(() => api.post('/onboarding/items', { ...form, role: form.role || null }), 'Step added');
          if (ok) {
            setForm({ title: '', description: '', link: '', role: '' });
            reload();
          }
        }}
      >
        <h2>Add a step</h2>
        <Field label="Title">
          <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Read the handbook" />
        </Field>
        <Field label="Description">
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field label="Link (optional)" hint="A knowledge page like /knowledge/… or an external URL.">
          <input value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} />
        </Field>
        <Field label="For">
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="">Everyone</option>
            {Object.entries(ROLE_LABEL).map(([r, l]) => (
              <option key={r} value={r}>
                {l}s
              </option>
            ))}
          </select>
        </Field>
        <button className="btn primary">Add step</button>
      </form>
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
    <>
    <form
      className="card form narrow-form"
      onSubmit={async (e) => {
        e.preventDefault();
        // Settings for features outside the current plan are left as they are.
        const { aiEnabled, retentionDays, legalHold, ...rest } = form;
        const payload = { ...rest, ...(has('ai') ? { aiEnabled } : {}), ...(has('retention') ? { retentionDays, legalHold } : {}) };
        const ok = await act(() => api.patch('/admin/workspace', payload), 'Workspace settings saved');
        if (ok) refresh();
      }}
    >
      <Field label="Workspace name">
        <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Message editing and deletion">
        <select value={form.messageEditPolicy} onChange={(e) => setForm({ ...form, messageEditPolicy: e.target.value as typeof form.messageEditPolicy })}>
          <option value="author">Authors can edit and delete their messages</option>
          <option value="admins">Only admins can edit or delete</option>
          <option value="none">No editing (admins can still delete)</option>
        </select>
      </Field>
      <Field label="Default guest access (days)">
        <input type="number" min={1} max={365} value={form.guestDefaultDays} onChange={(e) => setForm({ ...form, guestDefaultDays: Number(e.target.value) })} />
      </Field>
      <label className="check-row">
        <input type="checkbox" checked={form.requireMfa} onChange={(e) => setForm({ ...form, requireMfa: e.target.checked })} />
        <span>
          <strong>Require multifactor authentication</strong>
          <small className="muted block">Members without MFA must set it up before they can continue.</small>
        </span>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={form.aiEnabled && has('ai')} disabled={!ws.ai_available || !has('ai')} onChange={(e) => setForm({ ...form, aiEnabled: e.target.checked })} />
        <span>
          <strong>AI assistance</strong>
          <small className="muted block">
            {!has('ai')
              ? 'Available on the Business plan.'
              : ws.ai_available
              ? 'Lets people draft thread and meeting summaries, task suggestions and project briefs with Claude. It only reads content the requesting person can already open, drafts are never shared automatically, every use is audited, and channel or project owners can exclude their spaces.'
              : 'Not available: the server administrator must set ANTHROPIC_API_KEY first.'}
          </small>
        </span>
      </label>
      <h3>Retention</h3>
      {!has('retention') && <UpgradeNotice feature="retention" compact />}
      <fieldset disabled={!has('retention')} className="plain-fieldset">
      <Field label="Keep messages for" hint="Older messages are deleted automatically (a thread is kept while it has recent replies). Knowledge pages, decisions, tasks and library files are kept.">
        <select value={form.retentionDays ?? ''} onChange={(e) => setForm({ ...form, retentionDays: e.target.value ? Number(e.target.value) : null })}>
          <option value="">Forever</option>
          {[30, 90, 180, 365, 730, 1095, 1825, 2555, 3650].map((d) => (
            <option key={d} value={d}>
              {d < 365 ? `${d} days` : `${Math.round(d / 365)} year${d >= 730 ? 's' : ''}`}
            </option>
          ))}
        </select>
      </Field>
      <label className="check-row">
        <input type="checkbox" checked={form.legalHold} onChange={(e) => setForm({ ...form, legalHold: e.target.checked })} />
        <span>
          <strong>Legal hold</strong>
          <small className="muted block">Pauses all automatic deletion while an investigation or litigation is underway. Changes are recorded in the audit log.</small>
        </span>
      </label>
      </fieldset>
      <div className="form-actions spread">
        <a className="btn" href="/api/export">
          <Icon name="download" size={16} /> Export data
        </a>
        <button className="btn primary">Save settings</button>
      </div>
    </form>
    {me!.role === 'owner' && <DeleteWorkspace />}
    </>
  );
}

function Audit() {
  const [action, setAction] = useState('');
  const { data } = useApi<{ id: string; action: string; actor_name: string | null; target_type: string; target_id: string; detail: Record<string, unknown>; created_at: string }[]>(
    `/admin/audit${qs({ action, limit: 200 })}`,
  );
  return (
    <div className="card">
      <div className="toolbar">
        <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action">
          <option value="">All events</option>
          <option value="auth">Sign-ins</option>
          <option value="member">Member changes</option>
          <option value="invitation">Invitations</option>
          <option value="guest">Guest access</option>
          <option value="project">Projects</option>
          <option value="channel">Channels</option>
          <option value="file">Files</option>
          <option value="workspace">Workspace settings</option>
          <option value="data">Exports</option>
        </select>
      </div>
      {!data && <Loading />}
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>Action</th>
            <th className="hide-mobile">Details</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((e) => (
            <tr key={e.id}>
              <td>{dateTime(e.created_at)}</td>
              <td>{e.actor_name ?? 'System'}</td>
              <td>
                <code>{e.action}</code>
              </td>
              <td className="hide-mobile">
                <small className="muted">{Object.entries(e.detail).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
    <div className="card danger-zone narrow-form">
      <h2>Delete workspace</h2>
      <p className="muted">
        Permanently deletes {name} for everyone: messages, files, tasks, projects, knowledge, meetings and settings. This can't be undone. Export your data first if you
        may need it.
      </p>
      <button className="btn danger" onClick={() => setOpen(true)}>
        Delete this workspace
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Delete ${name}?`} eyebrow="DANGER">
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const res = await act(() => api.del<{ me: Me | null }>('/admin/workspace', { ...form, code: form.code || undefined }));
            if (res) {
              setMe(res.me);
              navigate('/');
            }
          }}
        >
          <p>
            Everything in <strong>{name}</strong> will be deleted, and all {me!.workspace.member_count} members lose access immediately.
          </p>
          <Field label={`Type the workspace name (${name}) to confirm`}>
            <input required value={form.confirmName} onChange={(e) => setForm({ ...form, confirmName: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Your password">
            <input required type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="current-password" />
          </Field>
          {me!.user.mfa_enabled && (
            <Field label="Authenticator code">
              <input required inputMode="numeric" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} autoComplete="one-time-code" />
            </Field>
          )}
          <div className="row-gap">
            <span className="grow" />
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Keep workspace
            </button>
            <button className="btn danger" disabled={form.confirmName.trim() !== name}>
              Delete forever
            </button>
          </div>
        </form>
      </Modal>
    </div>
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
    return <div className="card">Single sign-on needs the server setting <code>SOFTEX_SECRET_KEY</code> (used to encrypt the provider secret). Ask whoever runs SoftEX to set it.</div>;
  }
  return (
    <form
      className="card form narrow-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await act(() => api.put('/admin/sso', { ...f, clientSecret: f.clientSecret || undefined }), 'Single sign-on settings saved');
        if (ok) {
          setForm(null);
          reload();
        }
      }}
    >
      <h2>Single sign-on (OpenID Connect)</h2>
      <p className="muted">Works with Google Workspace, Microsoft Entra ID, Okta, Auth0, Keycloak and other OIDC providers. Register SoftEX with your provider using this redirect URI:</p>
      <code className="secret">{data.redirect_uri}</code>
      <Field label="Issuer URL" hint="e.g. https://accounts.google.com or https://login.microsoftonline.com/<tenant>/v2.0">
        <input required type="url" value={f.issuer} onChange={(e) => set({ issuer: e.target.value })} />
      </Field>
      <div className="form-row">
        <Field label="Client ID">
          <input required value={f.clientId} onChange={(e) => set({ clientId: e.target.value })} />
        </Field>
        <Field label="Client secret" hint={data.has_client_secret ? 'Leave blank to keep the saved secret.' : undefined}>
          <input type="password" value={f.clientSecret} onChange={(e) => set({ clientSecret: e.target.value })} placeholder={data.has_client_secret ? '••••••••' : ''} />
        </Field>
      </div>
      <Field label="Email domain" hint="People with this email domain are sent to your provider.">
        <input required value={f.domain} onChange={(e) => set({ domain: e.target.value })} placeholder="acme.com" />
      </Field>
      <label className="check-row">
        <input type="checkbox" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> <strong>Enable single sign-on</strong>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={f.autoProvision} onChange={(e) => set({ autoProvision: e.target.checked })} />
        <span>
          <strong>Create accounts automatically</strong>
          <small className="muted block">New people from your domain join as members the first time they sign in.</small>
        </span>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={f.required} onChange={(e) => set({ required: e.target.checked })} />
        <span>
          <strong>Require single sign-on</strong>
          <small className="muted block">Password sign-in is turned off for everyone except owners, who keep it as an emergency fallback.</small>
        </span>
      </label>
      <div className="form-actions">
        <button className="btn primary">Save</button>
      </div>
    </form>
  );
}

function ScimSettings() {
  const act = useAction();
  const { data, reload } = useApi<{ enabled: boolean; base_url: string }>('/admin/scim');
  const [token, setToken] = useState<string | null>(null);
  if (!data) return <Loading />;
  return (
    <div className="card form narrow-form">
      <h2>User provisioning (SCIM 2.0)</h2>
      <p className="muted">
        Let your identity provider (Okta, Microsoft Entra ID, OneLogin, JumpCloud…) create, update and deactivate SoftEX accounts automatically. Deactivating someone in
        the provider signs them out everywhere and revokes their API tokens. Owners can never be deactivated through SCIM.
      </p>
      <Field label="SCIM base URL">
        <code className="secret">{data.base_url}</code>
      </Field>
      <p>
        Status: <strong>{data.enabled ? 'Enabled' : 'Not set up'}</strong>
      </p>
      {token && (
        <div className="hint-box warn">
          <p>
            <strong>Copy this token now.</strong> It will not be shown again.
          </p>
          <code className="secret">{token}</code>
          <button className="btn sm" onClick={() => navigator.clipboard?.writeText(token)}>
            Copy
          </button>
        </div>
      )}
      <div className="form-actions spread">
        {data.enabled && (
          <button
            className="btn danger"
            onClick={async () => {
              if (!confirm('Turn off SCIM provisioning? Your identity provider will stop syncing.')) return;
              if (await act(() => api.del('/admin/scim/token'), 'SCIM provisioning turned off')) {
                setToken(null);
                reload();
              }
            }}
          >
            Turn off
          </button>
        )}
        <button
          className="btn primary"
          onClick={async () => {
            if (data.enabled && !confirm('Generate a new token? The current one stops working immediately.')) return;
            const res = await act(() => api.post<{ token: string }>('/admin/scim/token'));
            if (res) {
              setToken(res.token);
              reload();
            }
          }}
        >
          {data.enabled ? 'Rotate token' : 'Generate token'}
        </button>
      </div>
    </div>
  );
}

function Webhooks() {
  const act = useAction();
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
    <div className="two-col">
      <div className="card">
        <h2>Webhooks</h2>
        <p className="muted">
          SoftEX POSTs JSON events to these URLs, signed with HMAC-SHA256 in <code>X-SoftEX-Signature</code>. Events about private channels, private projects and direct
          messages are never sent.
        </p>
        {!data.webhooks.length && <p className="muted">No webhooks yet.</p>}
        {data.webhooks.map((w) => (
          <div key={w.id} className="team-row">
            <div className="row-gap wrap">
              <strong className="grow" style={{ overflowWrap: 'anywhere' }}>
                {w.url}
              </strong>
              <span className={`pill ${w.active ? 'status-done' : ''}`}>{w.active ? 'Active' : 'Paused'}</span>
            </div>
            <small className="muted">
              {w.description && `${w.description} · `}
              {w.events.join(', ')} · last 50: {w.recent?.delivered ?? 0} delivered, {w.recent?.failed ?? 0} failed, {w.recent?.pending ?? 0} pending
            </small>
            <div className="row-gap wrap">
              <button className="btn sm" onClick={() => setOpen(open === w.id ? null : w.id)}>
                {open === w.id ? 'Hide deliveries' : 'Deliveries'}
              </button>
              <button className="btn sm" onClick={async () => { await act(() => api.post(`/integrations/webhooks/${w.id}/ping`), 'Test event queued'); }}>
                Send test
              </button>
              <button className="btn sm" onClick={async () => { await act(() => api.patch(`/integrations/webhooks/${w.id}`, { active: !w.active })); reload(); }}>
                {w.active ? 'Pause' : 'Resume'}
              </button>
              <button
                className="btn sm"
                onClick={async () => {
                  const res = await act(() => api.post<{ secret: string }>(`/integrations/webhooks/${w.id}/rotate-secret`), 'Secret rotated');
                  if (res) setSecret(res.secret);
                }}
              >
                Rotate secret
              </button>
              <button
                className="btn sm danger-text"
                onClick={async () => {
                  if (!confirm('Delete this webhook?')) return;
                  await act(() => api.del(`/integrations/webhooks/${w.id}`), 'Webhook deleted');
                  reload();
                }}
              >
                Delete
              </button>
            </div>
            {open === w.id && (
              <table className="table">
                <tbody>
                  {(deliveries.data ?? []).map((d) => (
                    <tr key={d.id}>
                      <td>{new Date(d.created_at).toLocaleString()}</td>
                      <td>
                        <code>{d.event}</code>
                      </td>
                      <td>
                        <span className={`pill ${d.status === 'delivered' ? 'status-done' : d.status === 'failed' ? 'status-blocked' : ''}`}>{d.status}</span>
                      </td>
                      <td className="muted small">{d.response_status ?? ''} {d.last_error ?? ''}</td>
                    </tr>
                  ))}
                  {deliveries.data && !deliveries.data.length && (
                    <tr>
                      <td className="muted">No deliveries yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        ))}
        {secret && (
          <div className="hint-box token-reveal">
            <strong>Signing secret (shown once):</strong>
            <code className="secret">{secret}</code>
            <button className="btn sm" onClick={() => navigator.clipboard?.writeText(secret)}>
              Copy
            </button>
          </div>
        )}
      </div>
      <form
        className="card form"
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
        <h2>Add a webhook</h2>
        <Field label="Endpoint URL" hint="Must be a public https address.">
          <input required type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/softex-events" />
        </Field>
        <Field label="Description">
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field label="Events">
          <div className="check-list">
            {['*', ...data.events].map((ev) => (
              <label key={ev} className="check-inline">
                <input
                  type="checkbox"
                  checked={form.events.includes(ev)}
                  onChange={() => setForm({ ...form, events: form.events.includes(ev) ? form.events.filter((x) => x !== ev) : [...form.events, ev] })}
                />{' '}
                {ev === '*' ? 'All events' : ev}
              </label>
            ))}
          </div>
        </Field>
        <button className="btn primary" disabled={!form.events.length}>
          Add webhook
        </button>
      </form>
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
    <div className="card">
      <h2>Email</h2>
      {!data.smtp_configured && (
        <p className="hint-box warn">
          Email delivery is not configured, so messages are recorded here but not sent. Set <code>SOFTEX_SMTP_URL</code> and <code>SOFTEX_MAIL_FROM</code> on the server.
        </p>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>To</th>
            <th className="hide-mobile">Subject</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {data.emails.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.created_at).toLocaleString()}</td>
              <td>{e.to_email}</td>
              <td className="hide-mobile">{e.subject}</td>
              <td>
                <span className={`pill ${e.status === 'sent' ? 'status-done' : e.status === 'failed' ? 'status-blocked' : ''}`}>{e.status === 'logged' ? 'not sent' : e.status}</span>
                {e.last_error && <small className="muted block">{e.last_error}</small>}
                {e.status === 'failed' && (
                  <button className="link-btn" onClick={async () => { await act(() => api.post(`/integrations/emails/${e.id}/retry`), 'Queued for another attempt'); reload(); }}>
                    Retry
                  </button>
                )}
              </td>
            </tr>
          ))}
          {!data.emails.length && (
            <tr>
              <td className="muted">No emails yet.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
