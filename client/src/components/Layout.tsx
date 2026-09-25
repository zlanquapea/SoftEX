import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, type Channel } from '../api';
import { useApi, useRealtime } from '../hooks';
import { useSession } from '../session';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { SearchDialog } from './SearchDialog';
import { QuickCreate } from './QuickCreate';
import { TaskDrawer } from './TaskDrawer';
import { useToast } from './ui';
import { AccountBanners } from './Plan';
import { ROLE_LABEL } from '../format';
import { clearOfflineData } from '../pwa';
import { Logo } from './Logo';
import { setTheme, useTheme } from '../theme';

interface Shell {
  openTask: (id: string) => void;
  openCreate: (kind?: 'task' | 'project' | 'message' | 'meeting' | 'page') => void;
  openSearch: (q?: string) => void;
}
const ShellContext = createContext<Shell>({ openTask: () => {}, openCreate: () => {}, openSearch: () => {} });
export const useShell = () => useContext(ShellContext);

export function Layout({ children }: { children: ReactNode }) {
  const { me, logout, setMe, can } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [navOpen, setNavOpen] = useState(false);
  const [search, setSearch] = useState<{ open: boolean; q: string }>({ open: false, q: '' });
  const [create, setCreate] = useState<{ open: boolean; kind?: 'task' | 'project' | 'message' | 'meeting' | 'page' }>({ open: false });
  const [taskId, setTaskId] = useState<string | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  const [menu, setMenu] = useState<'profile' | 'workspace' | null>(null);
  const theme = useTheme();
  const { data: counts, reload: reloadCounts } = useApi<{ unread: number }>('/notifications?filter=unread&limit=1');
  const { data: channels, reload: reloadChannels } = useApi<Channel[]>('/channels');
  const { data: work, reload: reloadWork } = useApi<{ overdue: unknown[]; today: unknown[] }>('/my-work');

  useEffect(() => {
    setNavOpen(false);
    setMenu(null);
  }, [location.pathname]);

  useRealtime((e) => {
    if (e.type === 'notification') {
      reloadCounts();
      if (!e.silent && document.visibilityState === 'visible') toast(e.notification.title);
      if (!e.silent && document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') {
        new Notification(e.notification.title, { body: e.notification.body });
      }
    }
    if (e.type === 'message.created' || e.type === 'channel.updated' || e.type === 'reconnected') reloadChannels();
    if (e.type === 'task.updated' || e.type === 'reconnected') reloadWork();
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch({ open: true, q: '' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep unread counts fresh when a channel is read.
  useEffect(() => {
    const t = window.setTimeout(reloadChannels, 800);
    return () => window.clearTimeout(t);
  }, [location.pathname, reloadChannels]);

  const shell: Shell = {
    openTask: useCallback((id: string) => setTaskId(id), []),
    openCreate: useCallback((kind) => setCreate({ open: true, kind }), []),
    openSearch: useCallback((q = '') => setSearch({ open: true, q }), []),
  };

  if (!me) return null;
  const chatUnread = (channels ?? []).filter((c) => c.kind === 'dm').reduce((n, c) => n + c.unread, 0);
  const channelUnread = (channels ?? []).filter((c) => c.kind !== 'dm' && c.joined).reduce((n, c) => n + c.mentions, 0);
  const workDue = (work?.overdue.length ?? 0) + (work?.today.length ?? 0);
  const joinedChannels = (channels ?? []).filter((c) => c.kind !== 'dm' && c.joined);

  const switchWorkspace = async (id: string) => {
    setMenu(null);
    await clearOfflineData();
    setMe(await api.post('/me/switch-workspace', { workspaceId: id }));
    navigate('/');
  };

  const nav: { to: string; icon: string; label: string; badge?: number; soft?: boolean; end?: boolean }[] = [
    { to: '/', icon: 'home', label: 'Home', end: true },
    { to: '/inbox', icon: 'inbox', label: 'Inbox', badge: counts?.unread },
    { to: '/chats', icon: 'chat', label: 'Chats', badge: chatUnread },
    { to: '/channels', icon: 'hash', label: 'Channels', badge: channelUnread },
    { to: '/my-work', icon: 'check', label: 'My work', badge: workDue, soft: true },
    { to: '/projects', icon: 'folder', label: 'Projects' },
  ];
  const explore = [
    { to: '/knowledge', icon: 'book', label: 'Knowledge' },
    { to: '/meetings', icon: 'video', label: 'Meetings' },
    { to: '/directory', icon: 'users', label: 'Directory' },
    { to: '/decisions', icon: 'gavel', label: 'Decisions' },
    { to: '/requests', icon: 'inboxCheck', label: 'Requests' },
    { to: '/workload', icon: 'board', label: 'Workload' },
    { to: '/later', icon: 'clock', label: 'Later' },
  ];

  return (
    <ShellContext.Provider value={shell}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="app-shell">
        <aside className={`sidebar ${navOpen ? 'open' : ''}`} aria-label="Workspace navigation">
          <div className="brand">
            <Logo height={26} onDark />
            <button className="icon-btn sidebar-close" onClick={() => setNavOpen(false)} aria-label="Close navigation">
              <Icon name="x" />
            </button>
          </div>
          <div className="menu-anchor">
            <button className="workspace-switcher" onClick={() => setMenu(menu === 'workspace' ? null : 'workspace')} aria-expanded={menu === 'workspace'}>
              <span className="workspace-logo">{me.workspace.name[0]?.toUpperCase()}</span>
              <span>
                <strong>{me.workspace.name}</strong>
                <small>
                  {me.workspace.member_count} member{me.workspace.member_count === 1 ? '' : 's'} · {ROLE_LABEL[me.role]}
                </small>
              </span>
              <Icon name="chevronDown" size={15} />
            </button>
            {menu === 'workspace' && (
              <div className="popover" role="menu">
                <p className="popover-label">Workspaces</p>
                {me.workspaces.map((w) => (
                  <button key={w.id} role="menuitem" onClick={() => switchWorkspace(w.id)} className={w.id === me.workspace.id ? 'current' : ''}>
                    <span className="workspace-logo sm">{w.name[0]?.toUpperCase()}</span> {w.name}
                    {w.id === me.workspace.id && <Icon name="check" size={14} />}
                  </button>
                ))}
                {can('admin') && (
                  <Link role="menuitem" to="/admin">
                    <Icon name="shield" size={16} /> Administration
                  </Link>
                )}
                {can('admin') && me.mode === 'saas' && (
                  <Link role="menuitem" to="/admin?tab=billing">
                    <Icon name="flag" size={16} /> Plan & billing
                  </Link>
                )}
                {me.operator && (
                  <Link role="menuitem" to="/operator">
                    <Icon name="target" size={16} /> Operator console
                  </Link>
                )}
              </div>
            )}
          </div>
          <nav>
            <p className="nav-label">Workspace</p>
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                <Icon name={n.icon} />
                <span>{n.label}</span>
                {n.badge ? n.soft ? <em>{n.badge}</em> : <b>{n.badge}</b> : null}
              </NavLink>
            ))}
            {joinedChannels.length > 0 && (
              <div className="nav-channels" aria-label="Your channels">
                <p className="nav-label sub">Your channels</p>
                {joinedChannels.slice(0, 8).map((c) => (
                  <NavLink key={c.id} to={`/channels/${c.id}`} className={({ isActive }) => `nav-channel ${isActive ? 'active' : ''} ${c.unread ? 'unread' : ''}`}>
                    <Icon name={c.kind === 'private' ? 'lock' : c.kind === 'announcement' ? 'megaphone' : 'hash'} size={14} />
                    <span>{c.name}</span>
                    {c.mentions ? <b>{c.mentions}</b> : null}
                  </NavLink>
                ))}
              </div>
            )}
            <div className="nav-separator" />
            <p className="nav-label">Explore</p>
            {explore.map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                <Icon name={n.icon} />
                <span>{n.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-bottom">
            {can('lead') && (
              <Link className="invite-btn" to="/admin?tab=invitations">
                <Icon name="plus" size={15} /> Invite people
              </Link>
            )}
            <div className="menu-anchor">
              <button className="profile" onClick={() => setMenu(menu === 'profile' ? null : 'profile')} aria-expanded={menu === 'profile'}>
                <Avatar user={me.user} size="md" />
                <span>
                  <strong>{me.user.name}</strong>
                  <small>
                    <i className={`dot status-${me.user.status}`} /> {me.user.status_text || statusLabel(me.user.status)}
                  </small>
                </span>
                <Icon name="more" size={17} />
              </button>
              {menu === 'profile' && (
                <div className="popover up" role="menu">
                  {(['available', 'focus', 'busy', 'away'] as const).map((s) => (
                    <button
                      key={s}
                      role="menuitem"
                      onClick={async () => {
                        setMenu(null);
                        const focusUntil = s === 'focus' ? new Date(Date.now() + 60 * 60_000).toISOString() : null;
                        setMe(await api.patch('/me', { status: s, focus_until: focusUntil }));
                        if (s === 'focus') toast('Focus mode on for 1 hour. Notifications will be quiet unless urgent.');
                      }}
                    >
                      <i className={`dot status-${s}`} /> {statusLabel(s)}
                      {me.user.status === s && <Icon name="check" size={14} />}
                    </button>
                  ))}
                  <hr />
                  <button role="menuitem" onClick={() => setTheme(theme.shown === 'dark' ? 'light' : 'dark')}>
                    <Icon name={theme.shown === 'dark' ? 'sun' : 'moon'} size={16} /> {theme.shown === 'dark' ? 'Light mode' : 'Dark mode'}
                  </button>
                  <Link role="menuitem" to="/settings">
                    <Icon name="settings" size={16} /> Profile & preferences
                  </Link>
                  <Link role="menuitem" to={`/people/${me.user.id}`}>
                    <Icon name="users" size={16} /> View my profile
                  </Link>
                  <button role="menuitem" onClick={logout}>
                    <Icon name="logout" size={16} /> Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </aside>
        {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}

        <main id="main">
          <header className="topbar">
            <button className="icon-btn mobile-menu" aria-label="Open navigation" onClick={() => setNavOpen(true)}>
              <Icon name="menu" />
            </button>
            <button className="search" onClick={() => setSearch({ open: true, q: '' })}>
              <Icon name="search" />
              <span>Search messages, files, and people…</span>
              <kbd>⌘ K</kbd>
            </button>
            <div className="top-actions">
              <button className="btn primary sm hide-mobile" onClick={() => setCreate({ open: true })}>
                <Icon name="plus" size={16} /> Create
              </button>
              <Link to="/help" className="icon-btn hide-mobile" aria-label="Help">
                <Icon name="help" />
              </Link>
              <Link to="/inbox" className="icon-btn notification" aria-label={`Notifications${counts?.unread ? `, ${counts.unread} unread` : ''}`}>
                <Icon name="bell" />
                {counts?.unread ? <i /> : null}
              </Link>
              <Link to="/settings" aria-label="Your settings" className="hide-mobile">
                <Avatar user={me.user} size="md" />
              </Link>
            </div>
          </header>
          {me.role === 'guest' && me.guest_expires_at && (
            <div className="banner">
              You are a guest in {me.workspace.name}. Your access ends {new Date(me.guest_expires_at).toLocaleDateString()}.
            </div>
          )}
          <AccountBanners />
          <div className="content">{children}</div>
        </main>

        <nav className="mobile-nav" aria-label="Primary">
          <NavLink to="/" end>
            <Icon name="home" />
            <span>Home</span>
          </NavLink>
          <NavLink to="/inbox">
            <Icon name="inbox" />
            <span>Inbox</span>
            {counts?.unread ? <b>{counts.unread}</b> : null}
          </NavLink>
          <NavLink to="/chats">
            <Icon name="chat" />
            <span>Chats</span>
          </NavLink>
          <NavLink to="/my-work">
            <Icon name="check" />
            <span>My work</span>
          </NavLink>
          <button onClick={() => setSearch({ open: true, q: '' })}>
            <Icon name="search" />
            <span>Search</span>
          </button>
        </nav>
      </div>

      <SearchDialog open={search.open} initial={search.q} onClose={() => setSearch({ open: false, q: '' })} />
      <QuickCreate open={create.open} kind={create.kind} onClose={() => setCreate({ open: false })} />
      <TaskDrawer taskId={taskId} onClose={() => setTaskId(null)} />
      {!online && (
        <div className="offline-banner" role="status">
          <Icon name="alert" size={15} /> You are offline. Showing what was last loaded; changes will not be saved until you reconnect.
        </div>
      )}
    </ShellContext.Provider>
  );
}

export const statusLabel = (s: string) => ({ available: 'Available', focus: 'Focusing', busy: 'Busy', away: 'Away' })[s] ?? s;
