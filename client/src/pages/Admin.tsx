import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { api, qs, type Channel, type Project } from '../api';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { Empty, Field, Loading, PeoplePicker, Tabs, useAction } from '../components/ui';
import { dateTime, ROLE_LABEL, timeAgo } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';

type Tab = 'members' | 'invitations' | 'teams' | 'onboarding' | 'settings' | 'audit';

export function Admin() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const isAdmin = can('admin');
  const tab = (params.get('tab') as Tab) ?? (isAdmin ? 'members' : 'invitations');
  if (!can('lead')) return <Navigate to="/" replace />;
  const tabs: { id: Tab; label: string }[] = isAdmin
    ? [
        { id: 'members', label: 'Members' },
        { id: 'invitations', label: 'Invitations' },
        { id: 'teams', label: 'Teams' },
        { id: 'onboarding', label: 'Onboarding' },
        { id: 'settings', label: 'Workspace' },
        { id: 'audit', label: 'Audit log' },
      ]
    : [
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
      {tab === 'invitations' && <Invitations />}
      {tab === 'teams' && <Teams />}
      {tab === 'onboarding' && isAdmin && <OnboardingAdmin />}
      {tab === 'settings' && isAdmin && <WorkspaceSettings />}
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
  const [link, setLink] = useState<string | null>(null);
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
            setLink(`${location.origin}${res.url}`);
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
              Share this link with the invitee (valid for 14 days). It is shown only once.
            </p>
            <code className="secret">{link}</code>
            <button type="button" className="btn sm" onClick={() => navigator.clipboard?.writeText(link)}>
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
  const [form, setForm] = useState({ name: ws.name, messageEditPolicy: ws.message_edit_policy, guestDefaultDays: ws.guest_default_days, requireMfa: ws.require_mfa });
  return (
    <form
      className="card form narrow-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await act(() => api.patch('/admin/workspace', form), 'Workspace settings saved');
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
      <div className="form-actions spread">
        <a className="btn" href="/api/export">
          <Icon name="download" size={16} /> Export data
        </a>
        <button className="btn primary">Save settings</button>
      </div>
    </form>
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
