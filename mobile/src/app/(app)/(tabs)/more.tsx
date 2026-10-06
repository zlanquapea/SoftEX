import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api, type Me } from '@/lib/api';
import { ROLE_LABEL } from '@/lib/format';
import { useReloadOnFocus } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { statusLabel, useShell } from '@/lib/shell';
import { swatch, useTheme } from '@/lib/theme';
import { channelIcon, useFavorites } from '@/ui/chat';
import { ProfileSheet, STATUS_DOT } from '@/ui/header';
import { Icon } from '@/ui/Icon';
import { Avatar, Badge, Card, Dot, Eyebrow, ListRow, Muted, Row, Screen, Sheet, T, useAction } from '@/ui/kit';

const FAV_ICON: Record<string, string> = { page: 'book', project: 'folder', channel: 'hash', goal: 'target', dashboard: 'chart', board: 'whiteboard' };

function NavGroup({ title, children }: { title: string; children: React.ReactNode }) {
  const { c } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Eyebrow style={{ paddingHorizontal: 4 }}>{title}</Eyebrow>
      <Card padded={false} style={{ paddingHorizontal: 14 }}>
        {Array.isArray(children)
          ? children.filter(Boolean).map((child, i) => (
              <View key={i} style={i ? { borderTopWidth: 1, borderColor: c.line2 } : undefined}>
                {child}
              </View>
            ))
          : children}
      </Card>
    </View>
  );
}

function Item({ icon, label, to, badge, color }: { icon: string; label: string; to: string; badge?: number; color?: string }) {
  const { c } = useTheme();
  return (
    <ListRow
      left={
        <View style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: color ? `${color}22` : c.line2, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={icon} size={17} color={color ?? c.ink2} />
        </View>
      }
      title={label}
      right={badge ? <Badge count={badge} /> : undefined}
      chevron
      onPress={() => router.push(to as never)}
    />
  );
}

export default function More() {
  const { c } = useTheme();
  const { me, setMe, can, logout } = useSession();
  const { channels, counts, reloadChannels } = useShell();
  const favorites = useFavorites();
  const act = useAction();
  const [switching, setSwitching] = useState(false);
  const [profile, setProfile] = useState(false);
  useReloadOnFocus(reloadChannels);
  if (!me) return null;
  const joined = (channels ?? []).filter((ch) => ch.kind !== 'dm' && ch.joined);
  const guest = me.role === 'guest';

  const switchWorkspace = async (id: string) => {
    setSwitching(false);
    const next = await act(() => api.post<Me>('/me/switch-workspace', { workspaceId: id }));
    if (next) {
      setMe(next);
      router.replace('/');
    }
  };

  return (
    <Screen>
      <Pressable
        onPress={() => setSwitching(true)}
        accessibilityRole="button"
        accessibilityLabel={`${me.workspace.name}, switch workspace`}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16, backgroundColor: pressed ? c.nav2 : c.nav })}
      >
        <View style={{ width: 42, height: 42, borderRadius: 12, backgroundColor: c.navAccent, alignItems: 'center', justifyContent: 'center' }}>
          <T size={20} weight="displayHeavy" style={{ color: c.nav }}>
            {me.workspace.name[0]?.toUpperCase()}
          </T>
        </View>
        <View style={{ flex: 1 }}>
          <T weight="bold" style={{ color: c.navText }} numberOfLines={1}>
            {me.workspace.name}
          </T>
          <T size={12} style={{ color: c.navMuted }}>
            {me.workspace.member_count} member{me.workspace.member_count === 1 ? '' : 's'} · {ROLE_LABEL[me.role]}
          </T>
        </View>
        <Icon name="chevronDown" size={18} color={c.navMuted} />
      </Pressable>

      <Pressable onPress={() => setProfile(true)} accessibilityRole="button" style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, backgroundColor: pressed ? c.hover : c.surface, borderWidth: 1, borderColor: c.line })}>
        <Avatar user={me.user} size="md" presence />
        <View style={{ flex: 1 }}>
          <T weight="bold">{me.user.name}</T>
          <Row gap={6}>
            <Dot color={STATUS_DOT[me.user.status] ?? c.dotAway} />
            <Muted size={12}>{me.user.status_text || statusLabel(me.user.status)}</Muted>
          </Row>
        </View>
        <Icon name="more" size={17} color={c.muted} />
      </Pressable>

      <NavGroup title="Workspace">
        <Item icon="hash" label="Channels" to="/channels" badge={counts.channels} />
        {joined.slice(0, 8).map((ch) => (
          <ListRow
            key={ch.id}
            style={{ paddingLeft: 42 }}
            left={<Icon name={channelIcon(ch)} size={15} color={c.muted} />}
            title={
              <T size={14} weight={ch.unread ? 'bold' : 'medium'} numberOfLines={1}>
                {ch.name}
              </T>
            }
            right={ch.mentions ? <Badge count={ch.mentions} /> : ch.unread ? <Dot color={c.accent} /> : undefined}
            onPress={() => router.push(`/channels/${ch.id}`)}
          />
        ))}
        <Item icon="folder" label="Projects" to="/projects" />
        {!guest && <Item icon="target" label="Goals" to="/goals" />}
        {!guest && <Item icon="chart" label="Dashboards" to="/dashboards" />}
      </NavGroup>

      {favorites.length > 0 && (
        <NavGroup title="Favorites">
          {favorites.map((f) => (
            <ListRow
              key={`${f.kind}:${f.id}`}
              left={f.icon ? <T size={18}>{f.icon}</T> : f.color ? <Dot color={swatch(f.color)} size={10} /> : <Icon name={FAV_ICON[f.kind]} size={16} color={c.ink2} />}
              title={f.title}
              chevron
              onPress={() => router.push(f.link as never)}
            />
          ))}
        </NavGroup>
      )}

      <NavGroup title="Explore">
        <Item icon="book" label="Knowledge" to="/knowledge" />
        <Item icon="whiteboard" label="Whiteboards" to="/boards" />
        <Item icon="video" label="Meetings" to="/meetings" />
        <Item icon="users" label="Directory" to="/directory" />
        <Item icon="gavel" label="Decisions" to="/decisions" />
        <Item icon="inboxCheck" label="Requests" to="/requests" />
        <Item icon="board" label="Workload" to="/workload" />
        <Item icon="clock" label="Later" to="/later" />
        <Item icon="calendar" label="Timesheet" to="/timesheet" />
      </NavGroup>

      <NavGroup title="Account">
        {can('lead') && <Item icon="plus" label="Invite people" to="/admin?tab=invitations" color={c.accent} />}
        {can('admin') && <Item icon="shield" label="Administration" to="/admin" />}
        {can('admin') && me.mode === 'saas' && <Item icon="flag" label="Plan & billing" to="/billing" />}
        {me.operator && <Item icon="target" label="Operator console" to="/operator" />}
        <Item icon="settings" label="Settings" to="/settings" />
        <Item icon="help" label="Help" to="/help" />
        {me.mode === 'saas' && <Item icon="spark" label="Pricing" to="/pricing" />}
        <ListRow left={<View style={{ width: 30, alignItems: 'center' }}><Icon name="logout" size={17} color={c.red} /></View>} title={<T weight="semibold" tone="red">Sign out</T>} onPress={logout} />
      </NavGroup>

      <Sheet open={switching} onClose={() => setSwitching(false)} title="Workspaces">
        <View>
          {me.workspaces.map((w) => (
            <ListRow
              key={w.id}
              left={
                <View style={{ width: 32, height: 32, borderRadius: 9, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
                  <T weight="displayHeavy" tone="accent">
                    {w.name[0]?.toUpperCase()}
                  </T>
                </View>
              }
              title={w.name}
              subtitle={ROLE_LABEL[w.role]}
              right={w.id === me.workspace.id ? <Icon name="check" size={18} color={c.accent} /> : undefined}
              onPress={() => (w.id === me.workspace.id ? setSwitching(false) : switchWorkspace(w.id))}
            />
          ))}
        </View>
      </Sheet>
      <ProfileSheet open={profile} onClose={() => setProfile(false)} />
    </Screen>
  );
}
