import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { statusLabel, useShell } from '../lib/shell';
import { fonts, useTheme } from '../lib/theme';
import { Icon } from './Icon';
import { Avatar, Dot, IconButton, ListRow, Row, Sheet, T, useToast } from './kit';

export const STATUS_DOT: Record<string, string> = { available: '#55bf86', focus: '#c4552a', busy: '#c93a3a', away: '#b8a595' };

/** The top bar on each tab: page title, search, create and your profile — the web's top bar. */
export function AppHeader({ title }: { title: string }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { me } = useSession();
  const { openCreate, openSearch } = useShell();
  const [profile, setProfile] = useState(false);
  if (!me) return null;
  return (
    <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 16, paddingBottom: 8, backgroundColor: c.canvas }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T size={26} weight="displayHeavy" style={{ letterSpacing: -0.5, flexShrink: 1, lineHeight: 34 }} numberOfLines={1} accessibilityRole="header">
          {title}
        </T>
        <Row gap={2}>
          <IconButton name="search" label="Search" onPress={() => openSearch()} size={21} />
          <IconButton name="plus" label="Create" onPress={() => openCreate()} size={22} />
          <Pressable onPress={() => setProfile(true)} accessibilityRole="button" accessibilityLabel="Your profile and status" hitSlop={6} style={{ marginLeft: 6 }}>
            <Avatar user={me.user} size="sm" presence />
          </Pressable>
        </Row>
      </Row>
      <ProfileSheet open={profile} onClose={() => setProfile(false)} />
    </View>
  );
}

export function ProfileSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { c, dark, setChoice } = useTheme();
  const { me, setMe, logout } = useSession();
  const toast = useToast();
  if (!me) return null;
  const go = (path: string) => {
    onClose();
    setTimeout(() => router.push(path as never), 250);
  };
  return (
    <Sheet open={open} onClose={onClose}>
      <Row gap={12}>
        <Avatar user={me.user} size="lg" presence />
        <View style={{ flex: 1 }}>
          <T size={18} weight="display">
            {me.user.name}
          </T>
          <T size={13} tone="muted">
            {me.user.status_text || statusLabel(me.user.status)} · {me.user.email}
          </T>
        </View>
      </Row>
      <View>
        {(['available', 'focus', 'busy', 'away'] as const).map((s) => (
          <ListRow
            key={s}
            title={statusLabel(s)}
            left={<Dot color={STATUS_DOT[s]} size={10} />}
            right={me.user.status === s ? <Icon name="check" size={18} color={c.accent} /> : undefined}
            onPress={async () => {
              const focusUntil = s === 'focus' ? new Date(Date.now() + 60 * 60_000).toISOString() : null;
              setMe(await api.patch('/me', { status: s, focus_until: focusUntil }));
              if (s === 'focus') toast('Focus mode on for 1 hour. Notifications will be quiet unless urgent.');
            }}
          />
        ))}
      </View>
      <View style={{ height: 1, backgroundColor: c.line }} />
      <View>
        <ListRow title={dark ? 'Light mode' : 'Dark mode'} left={<Icon name={dark ? 'sun' : 'moon'} size={19} color={c.ink2} />} onPress={() => setChoice(dark ? 'light' : 'dark')} />
        <ListRow title="Profile & preferences" left={<Icon name="settings" size={19} color={c.ink2} />} onPress={() => go('/settings')} />
        <ListRow title="View my profile" left={<Icon name="users" size={19} color={c.ink2} />} onPress={() => go(`/people/${me.user.id}`)} />
        <ListRow
          title={<T weight="semibold" tone="red">Sign out</T>}
          left={<Icon name="logout" size={19} color={c.red} />}
          onPress={async () => {
            onClose();
            await logout();
          }}
        />
      </View>
    </Sheet>
  );
}

export const headerTitleStyle = { fontFamily: fonts.display, fontSize: 17 };
