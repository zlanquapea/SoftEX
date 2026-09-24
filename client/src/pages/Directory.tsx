import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Person } from '../api';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { statusLabel } from '../components/Layout';
import { Empty, ErrorState, Loading, Tabs, useAction } from '../components/ui';
import { localTimeIn, ROLE_LABEL } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';

export function Directory() {
  const { people } = useSession();
  const [tab, setTab] = useState<'people' | 'teams'>('people');
  const [q, setQ] = useState('');
  const [team, setTeam] = useState('');
  const { data: teams } = useApi<{ id: string; name: string; description: string; members: { id: string; name: string; color: string }[] }[]>('/teams');
  const filtered = people.filter(
    (p) =>
      (!q || `${p.name} ${p.title} ${p.expertise.join(' ')} ${p.email}`.toLowerCase().includes(q.toLowerCase())) &&
      (!team || p.teams.some((t) => t.id === team)),
  );
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Directory</h1>
          <p className="muted">Find people by team, role, expertise and working hours.</p>
        </div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'people', label: 'People', count: people.length }, { id: 'teams', label: 'Teams', count: teams?.length }]} />
      {tab === 'people' && (
        <>
          <div className="toolbar">
            <input className="filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, role or expertise (e.g. “design”, “SQL”)" aria-label="Search people" />
            <select value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Team">
              <option value="">All teams</option>
              {teams?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          {!filtered.length && <Empty icon="users" title="No one matches" />}
          <div className="people-grid">
            {filtered.map((p) => (
              <Link key={p.id} to={`/people/${p.id}`} className="person-card">
                <Avatar user={p} size="lg" showPresence />
                <div>
                  <strong>{p.name}</strong>
                  <small className="muted block">{p.title || ROLE_LABEL[p.role]}</small>
                  <small className="block">
                    <i className={`dot status-${p.status}`} /> {p.status_text || statusLabel(p.status)} · {localTimeIn(p.timezone)}
                  </small>
                  <div className="tags">
                    {p.role === 'guest' && <span className="pill">Guest</span>}
                    {p.teams.map((t) => (
                      <span key={t.id} className="pill">
                        {t.name}
                      </span>
                    ))}
                    {p.expertise.slice(0, 3).map((x) => (
                      <span key={x} className="pill tag">
                        {x}
                      </span>
                    ))}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
      {tab === 'teams' && (
        <div className="page-grid">
          {teams?.map((t) => (
            <div key={t.id} className="page-card">
              <h3>{t.name}</h3>
              <p className="muted">{t.description || 'No description.'}</p>
              <div className="chips">
                {t.members.map((m) => (
                  <Link key={m.id} to={`/people/${m.id}`} className="chip">
                    <Avatar user={m} size="xs" /> {m.name}
                  </Link>
                ))}
              </div>
            </div>
          ))}
          {teams && !teams.length && <Empty icon="users" title="No teams yet">Leads and admins can create teams in Administration.</Empty>}
        </div>
      )}
    </div>
  );
}

export function PersonView() {
  const { id } = useParams();
  const { me } = useSession();
  const navigate = useNavigate();
  const act = useAction();
  const { data: p, error } = useApi<Person & { projects: { id: string; name: string; color: string }[]; joined_at: string; mfa_enabled?: boolean }>(`/people/${id}`);
  if (error) return <ErrorState error={error} />;
  if (!p) return <Loading />;
  const isMe = p.id === me!.user.id;
  return (
    <div className="page narrow">
      <div className="card profile-card">
        <Avatar user={p} size="xl" showPresence />
        <div className="grow">
          <h1>{p.name}</h1>
          <p className="muted">
            {p.title || ROLE_LABEL[p.role]} · {ROLE_LABEL[p.role]}
          </p>
          <p>
            <i className={`dot status-${p.status}`} /> {p.status_text || statusLabel(p.status)}
            {p.focus_until && new Date(p.focus_until) > new Date() && ` until ${new Date(p.focus_until).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`}
          </p>
        </div>
        {isMe ? (
          <Link to="/settings" className="btn">
            Edit profile
          </Link>
        ) : (
          <button
            className="btn primary"
            onClick={async () => {
              const dm = await act(() => api.post<{ id: string }>('/dms', { userIds: [p.id] }));
              if (dm) navigate(`/channels/${dm.id}`);
            }}
          >
            <Icon name="chat" size={16} /> Message
          </button>
        )}
      </div>
      <div className="card">
        <dl className="props wide">
          <dt>Email</dt>
          <dd>
            <a href={`mailto:${p.email}`}>{p.email}</a>
          </dd>
          <dt>Local time</dt>
          <dd>
            {localTimeIn(p.timezone)} ({p.timezone})
          </dd>
          <dt>Working hours</dt>
          <dd>{p.working_hours}</dd>
          <dt>Teams</dt>
          <dd>{p.teams.map((t) => t.name).join(', ') || '—'}</dd>
          <dt>Expertise</dt>
          <dd className="tags">
            {p.expertise.length
              ? p.expertise.map((x) => (
                  <span key={x} className="pill tag">
                    {x}
                  </span>
                ))
              : '—'}
          </dd>
          <dt>Projects</dt>
          <dd className="tags">
            {p.projects.length
              ? p.projects.map((pr) => (
                  <Link key={pr.id} to={`/projects/${pr.id}`} className="pill">
                    <span className={`project-dot bg-${pr.color}`} /> {pr.name}
                  </Link>
                ))
              : '—'}
          </dd>
          {p.role === 'guest' && (
            <>
              <dt>Guest access</dt>
              <dd>
                Sponsored by {p.sponsor_name ?? '—'} · ends {p.guest_expires_at ? new Date(p.guest_expires_at).toLocaleDateString() : '—'}
              </dd>
            </>
          )}
          {p.mfa_enabled !== undefined && (
            <>
              <dt>MFA</dt>
              <dd>{p.mfa_enabled ? 'Enabled' : 'Not enabled'}</dd>
            </>
          )}
          <dt>Joined</dt>
          <dd>{new Date(p.joined_at).toLocaleDateString()}</dd>
        </dl>
      </div>
    </div>
  );
}
