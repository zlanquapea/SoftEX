import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs, type Notification } from '../api';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { Empty, ErrorState, Loading, Tabs, useAction } from '../components/ui';
import { plainMentions, timeAgo } from '../format';
import { useApi, useRealtime } from '../hooks';

type Filter = 'all' | 'unread' | 'mentions' | 'assigned' | 'meetings';
const KIND_ICON: Record<string, string> = {
  reminder: 'clock',
  deadline: 'calendar',
  automation: 'refresh',
  mention: 'chat',
  dm: 'chat',
  thread: 'thread',
  urgent: 'alert',
  assigned: 'task',
  review: 'eye',
  handoff: 'arrow',
  status: 'refresh',
  comment: 'chat',
  meeting: 'video',
  request: 'inboxCheck',
  announcement: 'megaphone',
  project: 'folder',
  channel: 'hash',
  page: 'book',
  file: 'file',
};

export function Inbox() {
  const [filter, setFilter] = useState<Filter>('all');
  const act = useAction();
  const { data, error, reload, setData } = useApi<{ notifications: (Notification & { actor_name: string; actor_color: string })[]; unread: number }>(
    `/notifications${qs({ filter, limit: 100 })}`,
  );
  const { data: digest } = useApi<{ kind: string; count: number; unread: number }[]>('/notifications/digest');
  useRealtime((e) => e.type === 'notification' && reload());

  const markRead = async (n: Notification, read = true) => {
    await api.post(`/notifications/${n.id}/read`, { read });
    setData(data && { ...data, notifications: data.notifications.map((x) => (x.id === n.id ? { ...x, read_at: read ? new Date().toISOString() : null } : x)) });
  };

  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>Inbox</h1>
          <p className="muted">Mentions, assignments, reviews, meeting updates and approvals in one place.</p>
        </div>
        <button
          className="btn"
          onClick={async () => {
            await act(() => api.post('/notifications/read-all'), 'All caught up');
            reload();
          }}
        >
          <Icon name="check" size={16} /> Mark all read
        </button>
      </div>
      {digest && digest.length > 0 && (
        <div className="digest" aria-label="Last 24 hours">
          <span className="muted small">Last 24 hours:</span>
          {digest.map((d) => (
            <span key={d.kind} className="pill">
              {d.count} {d.kind}
              {d.unread ? ` · ${d.unread} new` : ''}
            </span>
          ))}
        </div>
      )}
      <Tabs
        value={filter}
        onChange={setFilter}
        tabs={[
          { id: 'all', label: 'All' },
          { id: 'unread', label: 'Unread', count: data?.unread },
          { id: 'mentions', label: 'Mentions & DMs' },
          { id: 'assigned', label: 'Tasks' },
          { id: 'meetings', label: 'Meetings' },
        ]}
      />
      {error && <ErrorState error={error} retry={reload} />}
      {!data && !error && <Loading />}
      {data && !data.notifications.length && (
        <Empty icon="inbox" title="Nothing here">
          You are all caught up.
        </Empty>
      )}
      <ul className="inbox-list">
        {data?.notifications.map((n) => (
          <li key={n.id} className={`inbox-item ${n.read_at ? '' : 'unread'} ${n.urgent ? 'urgent' : ''}`}>
            {n.actor_name ? (
              <Avatar user={{ id: n.actor_id ?? undefined, name: n.actor_name, color: n.actor_color }} size="md" />
            ) : (
              <span className="activity-icon">
                <Icon name={KIND_ICON[n.kind] ?? 'bell'} size={16} />
              </span>
            )}
            <Link to={n.link || '/inbox'} onClick={() => !n.read_at && markRead(n)} className="inbox-body">
              <span className="inbox-title">
                <Icon name={KIND_ICON[n.kind] ?? 'bell'} size={14} /> {n.title}
              </span>
              {n.body && <span className="muted">{plainMentions(n.body)}</span>}
              <time>{timeAgo(n.created_at)}</time>
            </Link>
            <button className="icon-btn" onClick={() => markRead(n, !n.read_at)} aria-label={n.read_at ? 'Mark as unread' : 'Mark as read'} title={n.read_at ? 'Mark as unread' : 'Mark as read'}>
              <Icon name={n.read_at ? 'bell' : 'check'} size={16} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
