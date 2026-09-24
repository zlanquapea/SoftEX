import { initials } from '../format';
import { realtime } from '../realtime';

export function Avatar({
  user,
  size = 'md',
  showPresence = false,
}: {
  user: { id?: string; name: string; color?: string; status?: string } | null | undefined;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  showPresence?: boolean;
}) {
  if (!user) return <span className={`avatar avatar-${size} avatar-empty`} aria-hidden="true">?</span>;
  const online = user.id ? realtime.online.has(user.id) : false;
  return (
    <span className={`avatar avatar-${size} c-${user.color ?? 'purple'}`} title={user.name} aria-hidden="true">
      {initials(user.name)}
      {showPresence && <i className={`presence ${user.status === 'focus' ? 'focus' : online ? 'on' : 'off'}`} />}
    </span>
  );
}

export function AvatarStack({ users, max = 3, total }: { users: { id?: string; name: string; color?: string }[]; max?: number; total?: number }) {
  const extra = (total ?? users.length) - Math.min(max, users.length);
  return (
    <span className="avatar-stack" aria-label={users.map((u) => u.name).join(', ')}>
      {users.slice(0, max).map((u, i) => (
        <Avatar key={u.id ?? i} user={u} size="xs" />
      ))}
      {extra > 0 && <span className="avatar avatar-xs c-lilac">+{extra}</span>}
    </span>
  );
}
