const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function timeAgo(iso: string | null | undefined) {
  if (!iso) return '';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: abs > 86400 * 300 ? 'numeric' : undefined });
}

export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function dueLabel(due: string | null) {
  if (!due) return '';
  const today = localToday();
  if (due === today) return 'Today';
  const d = new Date(`${due}T00:00:00`);
  const t = new Date(`${today}T00:00:00`);
  const days = Math.round((d.getTime() - t.getTime()) / 86400000);
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

export const bytes = (n: number | null | undefined) => {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  const gb = n / 1024 ** 3;
  return `${gb >= 10 || Number.isInteger(gb) ? Math.round(gb) : gb.toFixed(1)} GB`;
};

export const STATUS_LABEL: Record<string, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  review: 'In review',
  done: 'Done',
};

export const HEALTH_LABEL: Record<string, string> = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track' };

export const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', lead: 'Team lead', member: 'Member', guest: 'Guest' };

export const localTimeIn = (tz: string) => {
  try {
    return new Date().toLocaleTimeString(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
};

/** Convert a local datetime-local input value to ISO. */
export const toIso = (local: string) => new Date(local).toISOString();
export const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Replace stored mention tokens with readable @names. */
export const plainMentions = (body: string) => body.replace(/@\[([^\]]+)\]\([0-9a-f-]{36}\)/g, '@$1');
