import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Channel } from '../api';
import { plainPreview, timeAgo } from '../format';
import { useApi, useRealtime } from '../hooks';
import { useSession } from '../session';
import { Avatar } from './Avatar';
import { useFavorites } from './Favorites';
import { Icon } from './Icon';
import { CountBadge, EmptyState, ErrorState, LoadingRows, SearchField } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Whether the window is at least `px` wide (kept up to date as it's resized). */
export function useMinWidth(px: number) {
  const query = `(min-width: ${px}px)`;
  const [wide, setWide] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mql = window.matchMedia?.(query);
    if (!mql) return;
    const on = () => setWide(mql.matches);
    on();
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, [query]);
  return wide;
}

/** What a conversation is called in lists: Saved, the people in a direct message, or a channel's name. */
export function conversationName(c: Channel, myId: string) {
  if (c.personal) return 'Saved';
  if (c.kind === 'dm') return c.members?.filter((m) => m.id !== myId).map((m) => m.name).join(', ') || 'Direct message';
  return c.name;
}

export const conversationIcon = (c: { kind: string; personal?: boolean }) =>
  c.personal ? 'bookmark' : c.kind === 'private' ? 'lock' : c.kind === 'announcement' ? 'megaphone' : c.kind === 'dm' ? 'chat' : 'hash';

function preview(c: Channel) {
  if (c.personal && !c.last_message) return 'Notes, links and messages you keep';
  if (!c.last_message) return c.kind === 'dm' ? 'No messages yet' : c.topic || 'No messages yet';
  const who = c.last_message.mine ? 'You: ' : c.kind !== 'dm' && c.last_message.author ? `${c.last_message.author}: ` : '';
  const text = plainPreview(c.last_message.text) || (c.last_message.forwarded ? 'Forwarded a message' : 'Sent an attachment');
  return `${c.personal ? '' : who}${text}`;
}

function Row({ c, active, myId, compact }: { c: Channel; active: boolean; myId: string; compact: boolean }) {
  const name = conversationName(c, myId);
  const unread = c.personal ? 0 : c.unread;
  const muted = c.notify === 'none';
  const others = c.members?.filter((m) => m.id !== myId) ?? [];
  return (
    <li>
      <Link
        to={`/channels/${c.id}`}
        aria-current={active ? 'page' : undefined}
        aria-label={`${c.kind === 'dm' || c.personal ? name : `#${name}`}${unread ? `, ${unread} unread` : ''}${c.mentions && c.kind !== 'dm' ? `, ${c.mentions} mentioning you` : ''}${muted ? ', muted' : ''}`}
        className={cn(
          'list-row group flex items-center gap-3 rounded-xl px-2.5 outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring',
          compact ? 'py-2' : 'py-2.5',
          active && 'bg-accent text-accent-foreground hover:bg-accent',
          unread > 0 && 'unread',
        )}
      >
        {c.kind === 'dm' && !c.personal && others.length === 1 ? (
          <Avatar user={others[0]} size="md" showPresence />
        ) : (
          <span
            className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground', c.personal ? 'bg-primary/10 text-primary' : 'bg-secondary')}
            aria-hidden="true"
          >
            {c.kind === 'dm' && !c.personal ? <span className="text-xs font-semibold">{others.length}</span> : <Icon name={conversationIcon(c)} size={16} />}
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col" aria-hidden="true">
          <span className="flex items-baseline justify-between gap-2">
            <strong className={cn('flex min-w-0 items-center gap-1 truncate text-sm', unread ? 'font-semibold' : 'font-medium')}>
              <span className="truncate">{name}</span>
              {muted && <Icon name="bellOff" size={12} className="shrink-0 text-muted-foreground" />}
            </strong>
            {c.last_message_at && <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{timeAgo(c.last_message_at)}</span>}
          </span>
          <span className="flex items-center gap-2">
            <span className={cn('list-preview min-w-0 flex-1 truncate text-xs', unread ? 'text-foreground' : 'text-muted-foreground')}>{preview(c)}</span>
            {c.mentions > 0 && c.kind !== 'dm' && (
              <span className="shrink-0 rounded-full bg-destructive px-1.5 text-[10px] leading-4 font-semibold text-white" aria-hidden="true">
                @{c.mentions}
              </span>
            )}
            {unread > 0 && !(c.mentions > 0 && c.kind !== 'dm') && <CountBadge count={unread} />}
          </span>
        </span>
      </Link>
    </li>
  );
}

function Group({ title, children, count }: { title: string; children: ReactNode; count?: number }) {
  return (
    <section aria-label={title} className="flex flex-col gap-0.5">
      <h2 className="px-2.5 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
        {count ? <span className="ml-1 font-normal normal-case">· {count}</span> : null}
      </h2>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </section>
  );
}

/**
 * Every conversation in one searchable list: your Saved at the top, then favourites, direct and group messages,
 * and the channels you're in — each with its unread count and the latest message.
 */
export function ConversationList({ activeId, compact = false, onNewMessage }: { activeId?: string; compact?: boolean; onNewMessage?: () => void }) {
  const { me } = useSession();
  const myId = me!.user.id;
  const { data: channels, error, reload } = useApi<Channel[]>('/channels');
  useRealtime((e) => ['message.created', 'message.removed', 'channel.updated', 'reconnected'].includes(e.type) && reload());
  const favorites = useFavorites();
  const [q, setQ] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const recent = (a: Channel, b: Channel) => (b.last_message_at ?? '').localeCompare(a.last_message_at ?? '');
    const all = (channels ?? []).filter((c) => c.personal || c.kind === 'dm' || c.joined);
    const shown = all.filter(
      (c) =>
        (!needle || conversationName(c, myId).toLowerCase().includes(needle) || (c.personal && 'saved notes'.includes(needle))) &&
        (!unreadOnly || (!c.personal && c.unread > 0)),
    );
    const fav = new Set(favorites.filter((f) => f.kind === 'channel').map((f) => f.id));
    return {
      saved: shown.find((c) => c.personal),
      favorites: shown.filter((c) => !c.personal && fav.has(c.id)).sort(recent),
      dms: shown.filter((c) => c.kind === 'dm' && !c.personal && !fav.has(c.id)).sort(recent),
      channels: shown.filter((c) => c.kind !== 'dm' && !fav.has(c.id)).sort(recent),
      total: shown.length,
      unread: all.filter((c) => !c.personal && c.unread > 0).length,
    };
  }, [channels, favorites, q, unreadOnly, myId]);

  return (
    <nav className="flex min-h-0 flex-col gap-2" aria-label="Conversations">
      <div className="flex items-center gap-2">
        <SearchField value={q} onChange={setQ} placeholder="Search conversations" className="max-w-none flex-1" />
        {onNewMessage && (
          <Button size="icon" variant="outline" onClick={onNewMessage} aria-label="New message" title="New message">
            <Icon name="edit" />
          </Button>
        )}
      </div>
      <div className="flex items-center gap-1" role="group" aria-label="Show">
        <Button size="xs" variant={unreadOnly ? 'ghost' : 'secondary'} aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>
          All
        </Button>
        <Button size="xs" variant={unreadOnly ? 'secondary' : 'ghost'} aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>
          Unread{groups.unread ? ` · ${groups.unread}` : ''}
        </Button>
      </div>
      {error && <ErrorState error={error} retry={reload} />}
      {!channels && !error && <LoadingRows rows={6} />}
      {channels && (
        <div className="flex min-h-0 flex-col">
          {groups.saved && (
            <ul className="flex flex-col">
              <Row c={groups.saved} active={activeId === groups.saved.id} myId={myId} compact={compact} />
            </ul>
          )}
          {groups.favorites.length > 0 && (
            <Group title="Favorites">
              {groups.favorites.map((c) => (
                <Row key={c.id} c={c} active={activeId === c.id} myId={myId} compact={compact} />
              ))}
            </Group>
          )}
          {groups.dms.length > 0 && (
            <Group title="Direct messages">
              {groups.dms.map((c) => (
                <Row key={c.id} c={c} active={activeId === c.id} myId={myId} compact={compact} />
              ))}
            </Group>
          )}
          {groups.channels.length > 0 && (
            <Group title="Channels">
              {groups.channels.map((c) => (
                <Row key={c.id} c={c} active={activeId === c.id} myId={myId} compact={compact} />
              ))}
            </Group>
          )}
          {groups.total === 0 && (
            <EmptyState icon={unreadOnly ? 'check' : 'search'} title={unreadOnly ? 'You’re all caught up' : 'No conversations match'}>
              {unreadOnly ? 'Nothing unread right now.' : 'Try another name, or start a new message.'}
            </EmptyState>
          )}
        </div>
      )}
    </nav>
  );
}
