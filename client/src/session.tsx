import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Me, type Person } from './api';
import { clearOfflineData } from './pwa';
import { realtime } from './realtime';

interface Session {
  me: Me | null;
  loading: boolean;
  setMe: (me: Me | null) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  people: Person[];
  reloadPeople: () => Promise<void>;
  can: (role: 'lead' | 'admin' | 'owner') => boolean;
}

const SessionContext = createContext<Session>(null as unknown as Session);
const RANK = { guest: 0, member: 1, lead: 2, admin: 3, owner: 4 } as const;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [people, setPeople] = useState<Person[]>([]);

  const refresh = useCallback(async () => {
    try {
      setMe(await api.get<Me>('/me'));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const reloadPeople = useCallback(async () => {
    try {
      setPeople(await api.get<Person[]>('/people'));
    } catch {
      /* ignored: e.g. MFA setup pending */
    }
  }, []);

  useEffect(() => {
    refresh();
    const onUnauthorized = () => {
      clearOfflineData();
      setMe(null);
    };
    window.addEventListener('softex:unauthorized', onUnauthorized);
    return () => window.removeEventListener('softex:unauthorized', onUnauthorized);
  }, [refresh]);

  const workspaceId = me?.workspace.id;
  useEffect(() => {
    if (!workspaceId) {
      realtime.stop();
      return;
    }
    realtime.start();
    reloadPeople();
    const off = realtime.subscribe((e) => {
      if (e.type === 'user.updated' || e.type === 'presence') {
        setPeople((ps) => ps.map((p) => (p.id === (e.user?.id ?? e.userId) ? { ...p, ...(e.user ?? {}), online: e.type === 'presence' ? e.online : p.online } : p)));
      }
    });
    return () => {
      off();
      realtime.stop();
    };
  }, [workspaceId, reloadPeople]);

  const logout = useCallback(async () => {
    await api.post('/auth/logout');
    await clearOfflineData();
    setMe(null);
  }, []);

  const can = useCallback((role: 'lead' | 'admin' | 'owner') => !!me && RANK[me.role] >= RANK[role], [me]);

  return <SessionContext.Provider value={{ me, loading, setMe, refresh, logout, people, reloadPeople, can }}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
