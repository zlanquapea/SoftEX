import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs, type Notification } from '../api';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { Empty, ErrorState, Loading, Tabs, useAction } from '../components/ui';
import { plainMentions, timeAgo } from '../format';
import { useApi, useRealtime } from '../hooks';

type Filter = 'all' | 'unread' | 'mentions' | 'assigned' | 'meetings';
export const KIND_ICON: Record<string, string> = {
  reminder: 'clock',
  billing: 'flag',
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

/** Names for notification kinds in the "Last 24 hours" summary: [one, many]. */
const KIND_LABEL: Record<string, [string, string]> = {
  reminder: ['reminder', 'reminders'],
  billing: ['billing notice', 'billing notices'],
  deadline: ['deadline', 'deadlines'],
  automation: ['automation', 'automations'],
  mention: ['mention', 'mentions'],
  dm: ['direct message', 'direct messages'],
  thread: ['thread reply', 'thread replies'],
  urgent: ['urgent message', 'urgent messages'],
  assigned: ['assignment', 'assignments'],
  review: ['review request', 'review requests'],
  handoff: ['handoff', 'handoffs'],
  status: ['status change', 'status changes'],
  comment: ['comment', 'comments'],
  meeting: ['meeting update', 'meeting updates'],
  request: ['request', 'requests'],
  announcement: ['announcement', 'announcements'],
  project: ['project update', 'project updates'],
  channel: ['channel update', 'channel updates'],
  page: ['page update', 'page updates'],
  file: ['file update', 'file updates'],
};
const kindLabel = (kind: string, count: number) => {
  const [one, many] = KIND_LABEL[kind] ?? [kind, kind];
  return `${count} ${count === 1 ? one : many}`;
};

export function Inbox() {
  const [filter, setFilter] = useState<Filter>('all');
  // Set by the "Last 24 hours" pills to show one kind of notification.
  const [kind, setKind] = useState<string | null>(null);
  const act = useAction();
  const { data, error, reload, setData } = useApi<{ notifications: (Notification & { actor_name: string; actor_color: string })[]; unread: number }>(
    `/notifications${qs({ filter, kind, limit: 100 })}`,
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
            <button
              key={d.kind}
              type="button"
              className={`pill pill-button ${kind === d.kind ? 'active' : ''}`}
              aria-pressed={kind === d.kind}
              onClick={() => {
                setKind(kind === d.kind ? null : d.kind);
                setFilter('all');
              }}
            >
              <Icon name={KIND_ICON[d.kind] ?? 'bell'} size={12} /> {kindLabel(d.kind, d.count)}
              {d.unread ? ` · ${d.unread} new` : ''}
            </button>
          ))}
        </div>
      )}
      {kind && (
        <p className="filter-note">
          Showing {KIND_LABEL[kind]?.[1] ?? kind} only.{' '}
          <button type="button" className="link-btn" onClick={() => setKind(null)}>
            Show everything
          </button>
        </p>
      )}
      <Tabs
        value={filter}
        onChange={(f) => {
          setFilter(f);
          setKind(null);
        }}
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
