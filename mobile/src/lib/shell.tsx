import { router } from 'expo-router';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { QuickCreate, type CreateKind } from '../ui/create';
import { useApi, useRealtime } from './hooks';
import type { Channel } from './api';

interface Shell {
  openCreate: (kind?: CreateKind) => void;
  openSearch: (q?: string) => void;
  openTask: (id: string) => void;
  /** Badge counts for the tab bar, kept fresh by realtime events. */
  counts: { inbox: number; chats: number; channels: number; work: number };
  reloadCounts: () => void;
  channels: Channel[] | undefined;
  reloadChannels: () => void;
}

const ShellContext = createContext<Shell>(null as unknown as Shell);
export const useShell = () => useContext(ShellContext);

export function ShellProvider({ children }: { children: ReactNode }) {
  const [create, setCreate] = useState<{ open: boolean; kind?: CreateKind }>({ open: false });
  const { data: unread, reload: reloadUnread } = useApi<{ unread: number }>('/notifications?filter=unread&limit=1');
  const { data: channels, reload: reloadChannels } = useApi<Channel[]>('/channels');
  const { data: work, reload: reloadWork } = useApi<{ overdue: unknown[]; today: unknown[] }>('/my-work');

  useRealtime((e) => {
    if (e.type === 'notification' || e.type === 'notifications.read' || e.type === 'reconnected') reloadUnread();
    if (e.type === 'message.created' || e.type === 'channel.updated' || e.type === 'channel.read' || e.type === 'reconnected') reloadChannels();
    if (e.type === 'task.updated' || e.type === 'reconnected') reloadWork();
  });

  const reloadCounts = useCallback(() => {
    reloadUnread();
    reloadChannels();
    reloadWork();
  }, [reloadUnread, reloadChannels, reloadWork]);

  const value = useMemo<Shell>(
    () => ({
      openCreate: (kind) => setCreate({ open: true, kind }),
      openSearch: (q = '') => router.push(q ? `/search?q=${encodeURIComponent(q)}` : '/search'),
      openTask: (id) => router.push(`/tasks/${id}`),
      counts: {
        inbox: unread?.unread ?? 0,
        chats: (channels ?? []).filter((c) => c.kind === 'dm').reduce((n, c) => n + c.unread, 0),
        channels: (channels ?? []).filter((c) => c.kind !== 'dm' && c.joined).reduce((n, c) => n + c.mentions, 0),
        work: (work?.overdue.length ?? 0) + (work?.today.length ?? 0),
      },
      reloadCounts,
      channels,
      reloadChannels,
    }),
    [unread, channels, work, reloadCounts, reloadChannels],
  );

  return (
    <ShellContext.Provider value={value}>
      {children}
      <QuickCreate open={create.open} kind={create.kind} onClose={() => setCreate({ open: false })} />
    </ShellContext.Provider>
  );
}

export const statusLabel = (s: string) => ({ available: 'Available', focus: 'Focusing', busy: 'Busy', away: 'Away' })[s] ?? s;
