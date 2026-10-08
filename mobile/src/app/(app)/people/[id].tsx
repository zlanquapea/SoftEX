import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Pressable, View } from 'react-native';
import { api, type Person } from '@/lib/api';
import { dateLabel, localTimeIn, ROLE_LABEL } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { statusLabel } from '@/lib/shell';
import { swatch, useTheme } from '@/lib/theme';
import { STATUS_DOT } from '@/ui/header';
import { Avatar, Button, Card, Dot, ErrorState, H1, Loading, Muted, Pill, Row, Screen, T, useAction } from '@/ui/kit';
import { openLink } from '@/ui/Markdown';
import { Prop } from '@/ui/work';

export default function PersonView() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const { me } = useSession();
  const act = useAction();
  const { data: p, error, reload } = useApi<Person & { projects: { id: string; name: string; color: string }[]; joined_at: string; mfa_enabled?: boolean }>(`/people/${id}`);
  if (error && !p) return <ErrorState error={error} retry={reload} />;
  if (!p) return <Loading />;
  const isMe = p.id === me!.user.id;
  return (
    <>
      <Stack.Screen options={{ title: p.name }} />
      <Screen>
        <Card style={{ alignItems: 'center', gap: 8, paddingVertical: 24 }}>
          <Avatar user={p} size="xl" presence />
          <H1 style={{ textAlign: 'center' }}>{p.name}</H1>
          <Muted size={14}>
            {p.title || ROLE_LABEL[p.role]} · {ROLE_LABEL[p.role]}
          </Muted>
          <Row gap={6}>
            <Dot color={STATUS_DOT[p.status] ?? c.dotAway} />
            <T size={14}>
              {p.status_text || statusLabel(p.status)}
              {p.focus_until && new Date(p.focus_until) > new Date() ? ` until ${new Date(p.focus_until).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}
            </T>
          </Row>
          {isMe ? (
            <Button title="Edit profile" onPress={() => router.push('/settings')} />
          ) : (
            <Button
              variant="primary"
              icon="chat"
              title="Message"
              onPress={async () => {
                const dm = await act(() => api.post<{ id: string }>('/dms', { userIds: [p.id] }));
                if (dm) router.push(`/channels/${dm.id}`);
              }}
            />
          )}
        </Card>
        <Card style={{ gap: 16 }}>
          <Prop label="Email">
            <T tone="accent" onPress={() => openLink(`mailto:${p.email}`)}>
              {p.email}
            </T>
          </Prop>
          <Prop label="Local time">
            <T>
              {localTimeIn(p.timezone)} ({p.timezone})
            </T>
          </Prop>
          <Prop label="Working hours">
            <T>{p.working_hours}</T>
          </Prop>
          <Prop label="Teams">
            <T>{p.teams.map((t) => t.name).join(', ') || '—'}</T>
          </Prop>
          <Prop label="Expertise">
            {p.expertise.length ? (
              <Row wrap gap={4}>
                {p.expertise.map((x) => (
                  <Pill key={x} label={x} tone="accent" />
                ))}
              </Row>
            ) : (
              <T>—</T>
            )}
          </Prop>
          <Prop label="Projects">
            {p.projects.length ? (
              <View style={{ gap: 6 }}>
                {p.projects.map((pr) => (
                  <Pressable key={pr.id} onPress={() => router.push(`/projects/${pr.id}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <View style={{ width: 9, height: 9, borderRadius: 3, backgroundColor: swatch(pr.color) }} />
                    <T tone="accent">{pr.name}</T>
                  </Pressable>
                ))}
              </View>
            ) : (
              <T>—</T>
            )}
          </Prop>
          {p.role === 'guest' && (
            <Prop label="Guest access">
              <T>
                Sponsored by {p.sponsor_name ?? '—'} · ends {p.guest_expires_at ? dateLabel(p.guest_expires_at) : '—'}
              </T>
            </Prop>
          )}
          {p.mfa_enabled !== undefined && (
            <Prop label="MFA">
              <T>{p.mfa_enabled ? 'Enabled' : 'Not enabled'}</T>
            </Prop>
          )}
          <Prop label="Joined">
            <T>{dateLabel(p.joined_at)}</T>
          </Prop>
        </Card>
      </Screen>
    </>
  );
}
