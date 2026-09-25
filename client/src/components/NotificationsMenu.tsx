import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, qs, type Notification } from '../api';
import { plainMentions, timeAgo } from '../format';
import { useApi, useRealtime } from '../hooks';
import { KIND_ICON } from '../pages/Inbox';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

type Item = Notification;

/**
 * The bell in the top bar: opens a list of recent notifications. Choosing one marks it read
 * and goes to what it's about; the full history stays in the Inbox.
 */
export function NotificationsMenu({ unread, onChange }: { unread: number; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const { data, reload, setData } = useApi<{ notifications: Item[]; unread: number }>(
    open ? `/notifications${qs({ filter: onlyUnread ? 'unread' : 'all', limit: 12 })}` : null,
  );
  useRealtime((e) => e.type === 'notification' && open && reload());

  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (n: Item) => {
    setOpen(false);
    if (!n.read_at) {
      void api.post(`/notifications/${n.id}/read`, { read: true }).then(onChange, () => {});
      setData(data && { ...data, notifications: data.notifications.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)) });
    }
    navigate(n.link || '/inbox');
  };

  const markAll = async () => {
    await api.post('/notifications/read-all');
    onChange();
    reload();
  };

  return (
    <div className="notif-anchor">
      <button
        ref={button}
        className="icon-btn notification"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="bell" />
        {unread ? <b className="notif-count">{unread > 99 ? '99+' : unread}</b> : null}
      </button>
      {open && (
        <div ref={panel} className="notif-panel" role="dialog" aria-label="Notifications">
          <header className="notif-head">
            <strong>Notifications</strong>
            <div className="notif-tabs" role="tablist">
              <button role="tab" aria-selected={!onlyUnread} className={!onlyUnread ? 'active' : ''} onClick={() => setOnlyUnread(false)}>
                All
              </button>
              <button role="tab" aria-selected={onlyUnread} className={onlyUnread ? 'active' : ''} onClick={() => setOnlyUnread(true)}>
                Unread{data?.unread ? ` (${data.unread})` : ''}
              </button>
            </div>
            {!!data?.unread && (
              <button className="link-btn small" onClick={markAll}>
                Mark all read
              </button>
            )}
          </header>
          <div className="notif-list">
            {!data && <p className="muted notif-empty">Loading…</p>}
            {data && !data.notifications.length && (
              <p className="muted notif-empty">{onlyUnread ? 'No unread notifications. You’re all caught up.' : 'No notifications yet.'}</p>
            )}
            {data?.notifications.map((n) => (
              <button key={n.id} className={`notif-item ${n.read_at ? '' : 'unread'} ${n.urgent ? 'urgent' : ''}`} onClick={() => choose(n)}>
                {n.actor_name ? (
                  <Avatar user={{ id: n.actor_id ?? undefined, name: n.actor_name, color: n.actor_color ?? 'purple' }} size="sm" />
                ) : (
                  <span className="notif-icon">
                    <Icon name={KIND_ICON[n.kind] ?? 'bell'} size={14} />
                  </span>
                )}
                <span className="notif-text">
                  <span className="notif-title">{n.title}</span>
                  {n.body && <span className="notif-body">{plainMentions(n.body)}</span>}
                  <time>{timeAgo(n.created_at)}</time>
                </span>
                {!n.read_at && <i className="notif-dot" aria-label="Unread" />}
              </button>
            ))}
          </div>
          <footer className="notif-foot">
            <Link to="/inbox" onClick={() => setOpen(false)}>
              Open Inbox <Icon name="arrow" size={14} />
            </Link>
          </footer>
        </div>
      )}
    </div>
  );
}
