import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../api';
import { Icon } from './Icon';
import { useAction } from './ui';

export type FavoriteKind = 'page' | 'project' | 'channel' | 'goal';
export interface Favorite {
  kind: FavoriteKind;
  id: string;
  title: string;
  icon: string | null;
  color?: string;
  link: string;
}

// One shared list for every star button and the sidebar, refreshed on change.
let cache: Favorite[] | null = null;
let pending: Promise<Favorite[]> | null = null;
const listeners = new Set<(f: Favorite[]) => void>();

async function load(force = false) {
  if (cache && !force) return cache;
  pending ??= api.get<Favorite[]>('/favorites').finally(() => (pending = null));
  cache = await pending;
  listeners.forEach((l) => l(cache!));
  return cache;
}

export function useFavorites() {
  const [items, setItems] = useState<Favorite[]>(cache ?? []);
  useEffect(() => {
    listeners.add(setItems);
    load().then(setItems, () => {});
    return () => void listeners.delete(setItems);
  }, []);
  return items;
}

/** Star toggle shown next to a page, project, channel or goal title. */
export function FavoriteButton({ kind, id }: { kind: FavoriteKind; id: string }) {
  const act = useAction();
  const items = useFavorites();
  const on = items.some((f) => f.kind === kind && f.id === id);
  return (
    <button
      type="button"
      className={`icon-btn fav-btn ${on ? 'on' : ''}`}
      aria-pressed={on}
      aria-label={on ? 'Remove from favorites' : 'Add to favorites'}
      title={on ? 'Remove from favorites' : 'Add to favorites'}
      onClick={async () => {
        const ok = await act(() => api.put('/favorites', { kind, id, on: !on }));
        if (ok) await load(true);
      }}
    >
      <Icon name="star" size={16} />
    </button>
  );
}

const KIND_ICON: Record<FavoriteKind, string> = { page: 'book', project: 'folder', channel: 'hash', goal: 'target' };

/** Sidebar section listing the person's favorites. */
export function FavoritesNav({ onNavigate }: { onNavigate?: () => void } = {}) {
  const items = useFavorites();
  if (!items.length) return null;
  return (
    <div className="nav-channels" aria-label="Favorites">
      <p className="nav-label sub">Favorites</p>
      {items.map((f) => (
        <NavLink key={`${f.kind}:${f.id}`} to={f.link} onClick={onNavigate} className={({ isActive }) => `nav-channel ${isActive ? 'active' : ''}`}>
          {f.icon ? <span className="nav-fav-emoji">{f.icon}</span> : f.color ? <span className={`project-dot bg-${f.color}`} /> : <Icon name={KIND_ICON[f.kind]} size={14} />}
          <span>{f.title}</span>
        </NavLink>
      ))}
    </div>
  );
}
