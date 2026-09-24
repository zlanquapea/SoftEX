import { useState } from 'react';
import { Link } from 'react-router-dom';
import { type Decision } from '../api';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { Empty, ErrorState, Loading } from '../components/ui';
import { dateTime } from '../format';
import { useApi } from '../hooks';

export function Decisions() {
  const { data, error, reload } = useApi<Decision[]>('/decisions?limit=200');
  const [q, setQ] = useState('');
  const list = (data ?? []).filter((d) => !q || `${d.title} ${d.rationale} ${d.project_name ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>Decisions</h1>
          <p className="muted">Every recorded decision you can access, linked back to where it was made.</p>
        </div>
      </div>
      <input className="filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter decisions" aria-label="Filter decisions" />
      {error && <ErrorState error={error} retry={reload} />}
      {!data && !error && <Loading />}
      {data && !list.length && (
        <Empty icon="gavel" title="No decisions yet">
          Record decisions from a message menu, a meeting, or a project’s Decisions tab.
        </Empty>
      )}
      <ul className="decision-list card">
        {list.map((d) => (
          <li key={d.id}>
            <span className="activity-icon decision">
              <Icon name="gavel" size={15} />
            </span>
            <div className="grow">
              <strong>{d.title}</strong>
              {d.rationale && <Markdown text={d.rationale} compact />}
              <small className="muted">
                {d.decided_by_name} · {dateTime(d.created_at)}
                {d.project_id && (
                  <>
                    {' · '}
                    <Link to={`/projects/${d.project_id}?tab=decisions`}>{d.project_name}</Link>
                  </>
                )}
                {d.channel_id && d.message_id && (
                  <>
                    {' · '}
                    <Link to={`/channels/${d.channel_id}?message=${d.message_id}`}>#{d.channel_name}</Link>
                  </>
                )}
                {d.meeting_id && (
                  <>
                    {' · '}
                    <Link to={`/meetings/${d.meeting_id}`}>{d.meeting_title}</Link>
                  </>
                )}
              </small>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
