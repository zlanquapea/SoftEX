import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { awayLabel, isAway } from '../away';
import { ChevronsUpDown, Ellipsis, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { api, type Channel } from '../api';
import { useApi, useRealtime } from '../hooks';
import { useSession } from '../session';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { SearchDialog } from './SearchDialog';
import { QuickCreate } from './QuickCreate';
import { TaskDrawer } from './TaskDrawer';
import { Callout, CountBadge, ErrorBoundary, Hint, IconButton, Loading, StatusDot, useToast } from '@/components/kit';
import { AccountBanners } from './Plan';
import { ROLE_LABEL, dateLabel, plainMentions } from '../format';
import { clearOfflineData } from '../pwa';
import { Logo, LogoMark } from './Logo';
import { setTheme, useTheme } from '../theme';
import { NotificationsMenu } from './NotificationsMenu';
import { PushPrompt } from './PushPrompt';
import { SaveBar } from './SaveBar';
import { FavoritesNav } from './Favorites';
import { ShortcutsDialog, useShortcuts } from './Shortcuts';
import { recordVisit } from '../recent';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';

interface Shell {
  openTask: (id: string) => void;
  openCreate: (kind?: 'task' | 'project' | 'message' | 'meeting' | 'page') => void;
  openSearch: (q?: string) => void;
}
const ShellContext = createContext<Shell>({ openTask: () => {}, openCreate: () => {}, openSearch: () => {} });
export const useShell = () => useContext(ShellContext);

/** A true/false preference kept in this browser. */
function useStoredFlag(key: string) {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, next ? '1' : '0');
      } catch {
        /* private mode: only for this visit */
      }
    },
    [key],
  );
  return [value, set] as const;
}

const READS_NOTIFICATIONS = /^\/(tasks|meetings|knowledge|projects|goals|files|boards|dashboards|forms)\/[^/]+$/;

interface NavEntry {
  to: string;
  icon: string;
  label: string;
  badge?: number;
  soft?: boolean;
  end?: boolean;
}

export function Layout({ children }: { children: ReactNode }) {
  const { me } = useSession();
  // The sidebar can fold into a narrow dock of icons; remembered on this device.
  const [docked, setDocked] = useStoredFlag('kuu:nav-docked');
  if (!me) return null;
  return (
    <SidebarProvider open={!docked} onOpenChange={(open) => setDocked(!open)}>
      <Shell docked={docked} setDocked={setDocked}>
        {children}
      </Shell>
    </SidebarProvider>
  );
}

function Shell({ children, docked, setDocked }: { children: ReactNode; docked: boolean; setDocked: (v: boolean) => void }) {
  const { me, logout, setMe, can } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const sidebar = useSidebar();
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
  const [channelsFolded, setChannelsFolded] = useStoredFlag('kuu:nav-channels-folded');
  const theme = useTheme();
  const { data: counts, reload: reloadCounts } = useApi<{ unread: number }>('/notifications?filter=unread&limit=1');
  const { data: channels, reload: reloadChannels } = useApi<Channel[]>('/channels');
  const { data: work, reload: reloadWork } = useApi<{ overdue: unknown[]; today: unknown[]; team?: unknown[] }>('/my-work');
  const { data: teams } = useApi<{ id: string; name: string; is_member: boolean }[]>('/teams');
  const myTeams = (teams ?? []).filter((t) => t.is_member);

  const { setOpenMobile } = sidebar;
  useEffect(() => setOpenMobile(false), [location.pathname, setOpenMobile]);

  // "See plans" on a plan-limit message: admins go to billing, everyone else to the plan comparison.
  useEffect(() => {
    const go = () => navigate(can('admin') && me?.mode === 'saas' ? '/admin?tab=billing' : '/pricing');
    window.addEventListener('kuu:see-plans', go);
    return () => window.removeEventListener('kuu:see-plans', go);
  }, [navigate, can, me?.mode]);

  // Moving between pages fades the new one in, which also smooths over the moment its data loads.
  const content = useRef<HTMLDivElement>(null);
  const firstPage = useRef(true);
  useEffect(() => {
    if (firstPage.current) {
      firstPage.current = false;
      return;
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    content.current?.animate?.([{ opacity: 0.35 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
  }, [location.pathname]);

  useRealtime((e) => {
    if (e.type === 'notification') {
      reloadCounts();
      if (!e.silent && document.visibilityState === 'visible') toast(e.notification.title);
      if (!e.silent && document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') {
        // Same tag as the push for this notification, so the browser shows it once.
        new Notification(e.notification.title, { body: plainMentions(e.notification.body ?? ''), tag: e.notification.id, icon: '/favicon.svg' });
      }
    }
    if (e.type === 'notifications.read') reloadCounts();
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

  // Single-key shortcuts ("/", "c", "?", "g" then a letter) and the sheet that lists them.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useShortcuts({
    onSearch: useCallback(() => setSearch({ open: true, q: '' }), []),
    onCreate: useCallback(() => setCreate({ open: true, kind: 'task' }), []),
    onHelp: useCallback(() => setShortcutsOpen(true), []),
  });
  useEffect(() => {
    const open = () => setShortcutsOpen(true);
    window.addEventListener('kuu:shortcuts', open);
    return () => window.removeEventListener('kuu:shortcuts', open);
  }, []);

  // Remember where you've been (on this device), so the command palette can take you back.
  useEffect(() => {
    const path = location.pathname + location.search;
    const t = window.setTimeout(() => {
      const heading = document.querySelector('#main h1')?.textContent?.trim();
      recordVisit(path, heading || document.title.split(' · ')[0]);
    }, 1200);
    return () => window.clearTimeout(t);
  }, [location.pathname, location.search]);

  // Opening a meeting, page, project, goal or file reads what you were notified about it (chats do this as they are read).
  // Not gated on the unread count: on a direct load (or a push notification tap) the count hasn't arrived yet.
  useEffect(() => {
    if (!READS_NOTIFICATIONS.test(location.pathname)) return;
    void api.post('/notifications/read-group', { group: location.pathname }).catch(() => {});
  }, [location.pathname]);

  // Keep unread counts fresh when a channel is read.
  useEffect(() => {
    const t = window.setTimeout(reloadChannels, 800);
    return () => window.clearTimeout(t);
  }, [location.pathname, reloadChannels]);

  // One object for the life of the shell: a new one each render would redraw everything that uses it whenever the
  // sidebar refreshes (which is on every new message).
  const shell = useMemo<Shell>(
    () => ({
      openTask: (id) => setTaskId(id),
      openCreate: (kind) => setCreate({ open: true, kind }),
      openSearch: (q = '') => setSearch({ open: true, q }),
    }),
    [],
  );

  if (!me) return null;
  const chatUnread = (channels ?? []).filter((c) => c.kind === 'dm').reduce((n, c) => n + c.unread, 0);
  const channelUnread = (channels ?? []).filter((c) => c.kind !== 'dm' && c.joined).reduce((n, c) => n + c.mentions, 0);
  const workDue = (work?.overdue.length ?? 0) + (work?.today.length ?? 0) + (work?.team?.length ?? 0);
  const joinedChannels = (channels ?? []).filter((c) => c.kind !== 'dm' && c.joined);
  const openChannelId = location.pathname.match(/^\/channels\/([^/]+)/)?.[1];
  const dmOpen = !!openChannelId && (channels ?? []).some((c) => c.id === openChannelId && c.kind === 'dm');

  const switchWorkspace = async (id: string) => {
    await clearOfflineData();
    setMe(await api.post('/me/switch-workspace', { workspaceId: id }));
    navigate('/');
  };

  const nav: NavEntry[] = [
    { to: '/', icon: 'home', label: 'Home', end: true },
    { to: '/chats', icon: 'chat', label: 'Chats', badge: chatUnread },
    { to: '/activities', icon: 'inbox', label: 'Activities', badge: counts?.unread },
    { to: '/channels', icon: 'hash', label: 'Channels', badge: channelUnread },
    { to: '/my-work', icon: 'check', label: 'My work', badge: workDue, soft: true },
    { to: '/projects', icon: 'folder', label: 'Projects' },
    { to: '/files', icon: 'files', label: 'Files' },
    ...(me.role === 'guest' ? [] : [{ to: '/goals', icon: 'target', label: 'Goals' }, { to: '/dashboards', icon: 'chart', label: 'Dashboards' }]),
  ];
  const explore: NavEntry[] = [
    { to: '/knowledge', icon: 'book', label: 'Knowledge' },
    { to: '/boards', icon: 'whiteboard', label: 'Whiteboards' },
    { to: '/meetings', icon: 'video', label: 'Meetings' },
    { to: '/directory', icon: 'users', label: 'Directory' },
    { to: '/decisions', icon: 'gavel', label: 'Decisions' },
    { to: '/requests', icon: 'inboxCheck', label: 'Requests' },
    { to: '/workload', icon: 'board', label: 'Workload' },
    { to: '/later', icon: 'clock', label: 'Later' },
    { to: '/timesheet', icon: 'calendar', label: 'Timesheet' },
  ];
  const isActive = (n: NavEntry) => {
    const here = n.end ? location.pathname === n.to : location.pathname === n.to || location.pathname.startsWith(`${n.to}/`);
    // A direct message lives under /channels/…, but belongs with Chats.
    return n.to === '/chats' ? here || dmOpen : n.to === '/channels' ? here && !dmOpen : here;
  };

  const navItem = (n: NavEntry) => {
    const active = isActive(n);
    return (
      <SidebarMenuButton
        isActive={active}
        tooltip={n.label}
        className={cn('nav-item', active && 'active')}
        aria-label={docked ? `${n.label}${n.badge ? `, ${n.badge}` : ''}` : undefined}
        // With a direct message open (/channels/<id>), only Chats is the current page, so Channels matches its own address only.
        render={<NavLink to={n.to} end={n.end || (n.to === '/channels' && dmOpen)} />}
      >
        <Icon name={n.icon} />
        <span>{n.label}</span>
      </SidebarMenuButton>
    );
  };

  return (
    <ShellContext.Provider value={shell}>
      <SaveBar />
      <a
        className="fixed top-2 -left-[999px] z-50 rounded-lg bg-primary px-3 py-2 text-primary-foreground focus:left-2"
        href="#main"
      >
        Skip to content
      </a>

      <Sidebar collapsible="icon" aria-label="Workspace navigation" role="complementary" className={cn('border-sidebar-border', docked && 'docked')}>
        <SidebarHeader className="gap-3">
          <div className="flex items-center justify-between gap-2 px-1 pt-1 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:px-0">
            <Link to="/" aria-label="Küü home" className="flex items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring">
              {docked ? <LogoMark size={30} /> : <Logo height={24} onDark />}
            </Link>
            <IconButton
              label={docked ? 'Expand the sidebar' : 'Collapse the sidebar into a dock'}
              size="icon-sm"
              aria-pressed={docked}
              className="text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground max-md:hidden"
              onClick={() => setDocked(!docked)}
            >
              {docked ? <PanelLeftOpen /> : <PanelLeftClose />}
            </IconButton>
          </div>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<SidebarMenuButton size="lg" tooltip={me.workspace.name} className="data-popup-open:bg-sidebar-accent" />}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary font-semibold text-sidebar-primary-foreground">
                    {me.workspace.name[0]?.toUpperCase()}
                  </span>
                  <span className="grid flex-1 text-left leading-tight">
                    <span className="truncate font-semibold">{me.workspace.name}</span>
                    <span className="truncate text-xs text-sidebar-foreground/60">
                      {me.workspace.member_count} member{me.workspace.member_count === 1 ? '' : 's'} · {ROLE_LABEL[me.role]}
                    </span>
                  </span>
                  <ChevronsUpDown className="ml-auto" />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="min-w-60" align="start" side={sidebar.isMobile ? 'bottom' : 'right'}>
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                    {me.workspaces.map((w) => (
                      <DropdownMenuItem key={w.id} onClick={() => w.id !== me.workspace.id && switchWorkspace(w.id)}>
                        <span className="flex size-6 items-center justify-center rounded-md border text-xs font-semibold">{w.name[0]?.toUpperCase()}</span>
                        {w.name}
                        {w.id === me.workspace.id && <Icon name="check" className="ml-auto" />}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                  {(can('admin') || me.operator) && <DropdownMenuSeparator />}
                  <DropdownMenuGroup>
                    {can('admin') && (
                      <DropdownMenuItem render={<Link to="/admin" />}>
                        <Icon name="shield" /> Administration
                      </DropdownMenuItem>
                    )}
                    {can('admin') && me.mode === 'saas' && (
                      <DropdownMenuItem render={<Link to="/admin?tab=billing" />}>
                        <Icon name="flag" /> Plan & billing
                      </DropdownMenuItem>
                    )}
                    {me.operator && (
                      <DropdownMenuItem render={<Link to="/operator" />}>
                        <Icon name="target" /> Operator console
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent className="nav-scroll">
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {nav.map((n) => (
                  <SidebarMenuItem key={n.to}>
                    {navItem(n)}
                    {n.badge ? (
                      <SidebarMenuBadge className={cn(n.to === '/channels' && joinedChannels.length > 0 && 'right-8', n.soft ? 'text-sidebar-foreground/70' : 'rounded-full bg-sidebar-primary px-1.5 text-sidebar-primary-foreground')}>
                        {n.badge}
                      </SidebarMenuBadge>
                    ) : null}
                    {n.to === '/channels' && joinedChannels.length > 0 && (
                      <>
                        <SidebarMenuAction
                          onClick={() => setChannelsFolded(!channelsFolded)}
                          aria-expanded={!channelsFolded}
                          aria-controls="nav-channels"
                          aria-label={channelsFolded ? 'Show your channels' : 'Hide your channels'}
                          title={channelsFolded ? 'Show your channels' : 'Hide your channels'}
                        >
                          <Icon name={channelsFolded ? 'chevronRight' : 'chevronDown'} />
                        </SidebarMenuAction>
                        {!channelsFolded && !docked && (
                          <SidebarMenuSub id="nav-channels" aria-label="Your channels">
                            {joinedChannels.slice(0, 8).map((c) => {
                              const here = location.pathname === `/channels/${c.id}`;
                              return (
                                <SidebarMenuSubItem key={c.id}>
                                  <SidebarMenuSubButton isActive={here} className={cn(c.unread && 'font-semibold text-sidebar-foreground')} render={<NavLink to={`/channels/${c.id}`} />}>
                                    <Icon name={c.kind === 'private' ? 'lock' : c.kind === 'announcement' ? 'megaphone' : 'hash'} />
                                    <span>{c.name}</span>
                                    {c.mentions ? <CountBadge count={c.mentions} className="ml-auto" /> : null}
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              );
                            })}
                            {joinedChannels.length > 8 && (
                              <SidebarMenuSubItem>
                                <SidebarMenuSubButton className="text-sidebar-foreground/60" render={<NavLink to="/channels" end />}>
                                  <span>All {joinedChannels.length} channels</span>
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            )}
                          </SidebarMenuSub>
                        )}
                      </>
                    )}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {myTeams.length > 0 && (
            <SidebarGroup>
              <SidebarGroupLabel>Your teams</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu aria-label="Your teams">
                  {myTeams.map((t) => (
                    <SidebarMenuItem key={t.id}>
                      <SidebarMenuButton isActive={location.pathname === `/teams/${t.id}`} tooltip={t.name} render={<NavLink to={`/teams/${t.id}`} />}>
                        <Icon name="users" />
                        <span>{t.name}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
          <FavoritesNav />
          <SidebarSeparator />
          <SidebarGroup>
            <SidebarGroupLabel>Explore</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {explore.map((n) => (
                  <SidebarMenuItem key={n.to}>{navItem(n)}</SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            {can('lead') && (
              <SidebarMenuItem>
                <SidebarMenuButton variant="outline" tooltip="Invite people" className="border border-dashed border-sidebar-border bg-transparent shadow-none" render={<Link to="/admin?tab=invitations" />}>
                  <Icon name="plus" />
                  <span>Invite people</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton
                      size="lg"
                      className="profile data-popup-open:bg-sidebar-accent"
                      tooltip={`${me.user.name} · ${isAway(me.user) ? awayLabel(me.user) : me.user.status_text || statusLabel(me.user.status)}`}
                    />
                  }
                >
                  <Avatar user={me.user} size="md" />
                  <span className="grid flex-1 text-left leading-tight">
                    <span className="truncate font-semibold">{me.user.name}</span>
                    <span className="flex items-center gap-1.5 truncate text-xs text-sidebar-foreground/60">
                      {isAway(me.user) ? (
                        <>
                          <Icon name="away" size={12} /> {awayLabel(me.user)}
                        </>
                      ) : (
                        <>
                          <StatusDot status={me.user.status} /> {me.user.status_text || statusLabel(me.user.status)}
                        </>
                      )}
                    </span>
                  </span>
                  <Ellipsis className="ml-auto" />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="min-w-56" align="end" side={sidebar.isMobile ? 'top' : 'right'}>
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Status</DropdownMenuLabel>
                    {(['available', 'focus', 'busy', 'away'] as const).map((s) => (
                      <DropdownMenuItem
                        key={s}
                        onClick={async () => {
                          const focusUntil = s === 'focus' ? new Date(Date.now() + 60 * 60_000).toISOString() : null;
                          setMe(await api.patch('/me', { status: s, focus_until: focusUntil }));
                          if (s === 'focus') toast('Focus mode on for 1 hour. Notifications will be quiet unless urgent.');
                        }}
                      >
                        <StatusDot status={s} /> {statusLabel(s)}
                        {me.user.status === s && <Icon name="check" className="ml-auto" />}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem render={<Link to="/settings?section=notifications" />}>
                      <Icon name="away" /> {isAway(me.user) ? awayLabel(me.user) : 'Set out of office…'}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={() => setTheme(theme.shown === 'dark' ? 'light' : 'dark')}>
                      <Icon name={theme.shown === 'dark' ? 'sun' : 'moon'} /> {theme.shown === 'dark' ? 'Light mode' : 'Dark mode'}
                    </DropdownMenuItem>
                    <DropdownMenuItem render={<Link to="/settings" />}>
                      <Icon name="settings" /> Profile & preferences
                    </DropdownMenuItem>
                    <DropdownMenuItem render={<Link to={`/people/${me.user.id}`} />}>
                      <Icon name="users" /> View my profile
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem onClick={logout}>
                      <Icon name="logout" /> Sign out
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset id="main" className="min-w-0 pb-16 md:pb-0">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur md:px-4">
          <SidebarTrigger className="md:hidden" aria-label="Open navigation" />
          <Separator orientation="vertical" className="mr-1 h-5 md:hidden" />
          <Button
            variant="outline"
            className="h-9 min-w-0 flex-1 justify-start gap-2 bg-card font-normal text-muted-foreground md:max-w-md"
            onClick={() => setSearch({ open: true, q: '' })}
          >
            <Icon name="search" data-icon="inline-start" />
            <span className="truncate">Search messages, files, and people…</span>
            <Kbd className="ml-auto max-sm:hidden">⌘ K</Kbd>
          </Button>
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" className="max-md:hidden" onClick={() => setCreate({ open: true })}>
              <Icon name="plus" data-icon="inline-start" /> Create
            </Button>
            <Hint label="Help">
              <Link to="/help" aria-label="Help" className={buttonVariants({ variant: 'ghost', size: 'icon', className: 'max-md:hidden' })}>
                <Icon name="help" />
              </Link>
            </Hint>
            <NotificationsMenu unread={counts?.unread ?? 0} onChange={reloadCounts} />
            <Link to="/settings" aria-label="Your settings" className="rounded-full max-md:hidden">
              <Avatar user={me.user} size="md" />
            </Link>
          </div>
        </header>
        {me.role === 'guest' && me.guest_expires_at && (
          <Callout tone="info" className="rounded-none border-x-0 border-t-0">
            You are a guest in {me.workspace.name}. Your access ends {dateLabel(me.guest_expires_at)}.
          </Callout>
        )}
        <AccountBanners />
        <div className="min-w-0 flex-1" ref={content}>
          <ErrorBoundary resetKey={location.pathname}>
            <Suspense fallback={<Loading />}>{children}</Suspense>
          </ErrorBoundary>
        </div>
      </SidebarInset>

      <MobileNav unread={counts?.unread ?? 0} onSearch={() => setSearch({ open: true, q: '' })} />

      <SearchDialog open={search.open} initial={search.q} onClose={() => setSearch({ open: false, q: '' })} />
      <QuickCreate open={create.open} kind={create.kind} onClose={() => setCreate({ open: false })} />
      <TaskDrawer taskId={taskId} onClose={() => setTaskId(null)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <PushPrompt />
      {!online && (
        <div className="fixed inset-x-3 bottom-20 z-40 mx-auto max-w-xl md:bottom-4">
          <Callout tone="warning" className="shadow-lg">
            You are offline. Showing what was last loaded; changes will not be saved until you reconnect.
          </Callout>
        </div>
      )}
    </ShellContext.Provider>
  );
}

/** The bottom tab bar on phones. */
function MobileNav({ unread, onSearch }: { unread: number; onSearch: () => void }) {
  // h-16 matches the 4rem that full-height screens (chats) leave for this bar.
  const tab = 'relative flex h-16 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-medium text-muted-foreground [&.active]:text-primary';
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <NavLink to="/" end className={tab}>
        <Icon name="home" size={20} />
        <span>Home</span>
      </NavLink>
      <NavLink to="/chats" className={tab}>
        <Icon name="chat" size={20} />
        <span>Chats</span>
      </NavLink>
      {/* Activities sits in the middle: what needs you, front and centre. */}
      <NavLink to="/activities" className={tab}>
        <Icon name="inbox" size={20} />
        <span>Activities</span>
        <CountBadge count={unread} className="absolute top-1 left-1/2 ml-1 h-4 min-w-4 px-1 text-[10px]" />
      </NavLink>
      <NavLink to="/my-work" className={tab}>
        <Icon name="check" size={20} />
        <span>My work</span>
      </NavLink>
      <button type="button" className={tab} onClick={onSearch}>
        <Icon name="search" size={20} />
        <span>Search</span>
      </button>
    </nav>
  );
}

export const statusLabel = (s: string) => ({ available: 'Available', focus: 'Focusing', busy: 'Busy', away: 'Away' })[s] ?? s;
