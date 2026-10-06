import * as Clipboard from 'expo-clipboard';
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api, qs, type Meeting } from '@/lib/api';
import { timeOf } from '@/lib/format';
import { useApi, useRealtime, useReloadOnFocus } from '@/lib/hooks';
import { useShell } from '@/lib/shell';
import { swatch, useTheme } from '@/lib/theme';
import { Icon } from '@/ui/Icon';
import { AvatarStack, Button, Card, Empty, ErrorState, Eyebrow, IconButton, Loading, Muted, Pill, Row, Screen, Sheet, T, Tabs, useAction, useToast } from '@/ui/kit';
import { openLink } from '@/ui/Markdown';

/** Private calendar subscription link for Google Calendar, Outlook or Apple Calendar. */
function CalendarSubscribe({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { c } = useTheme();
  const act = useAction();
  const toast = useToast();
  const { data, reload } = useApi<{ enabled: boolean; created_at: string | null; last_used_at: string | null }>(open ? '/me/calendar-feed' : null);
  const [link, setLink] = useState<{ url: string; webcal: string } | null>(null);
  const create = async () => {
    const res = await act(() => api.post<{ url: string; webcal: string }>('/me/calendar-feed'));
    if (res) {
      setLink(res);
      reload();
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Add Küü meetings to your calendar">
      <Muted>
        Subscribe once and your Küü meetings (the ones you organise or were invited to) show up in Google Calendar, Outlook or Apple Calendar. Calendar apps refresh subscriptions every few hours, so a change can take a while to appear.
      </Muted>
      {link ? (
        <View style={{ gap: 10, padding: 12, borderRadius: 12, backgroundColor: c.amberSoft }}>
          <T weight="bold">Copy this private link now. It won’t be shown again.</T>
          <T size={13} selectable>
            {link.url}
          </T>
          <Row wrap>
            <Button
              small
              title="Copy link"
              onPress={async () => {
                await Clipboard.setStringAsync(link.url);
                toast('Link copied');
              }}
            />
            <Button small title="Open in calendar app" onPress={() => openLink(link.webcal.replace(/^webcal:/, 'https:'))} />
          </Row>
          <Muted size={12}>Google Calendar: Other calendars → + → From URL. Outlook: Add calendar → Subscribe from web. Anyone with the link can see your meeting titles and times, so keep it private.</Muted>
        </View>
      ) : data?.enabled ? (
        <>
          <T>
            You have a calendar link{data.last_used_at ? `, last read by your calendar ${new Date(data.last_used_at).toLocaleString()}` : ''}. Links are only shown when created; make a new one if you’ve lost it (the old link stops working).
          </T>
          <Row>
            <Button
              variant="danger"
              title="Turn off"
              onPress={async () => {
                await act(() => api.del('/me/calendar-feed'), 'Calendar link turned off');
                reload();
              }}
            />
            <Button variant="primary" title="Make a new link" onPress={create} />
          </Row>
        </>
      ) : (
        data && <Button variant="primary" title="Create my calendar link" onPress={create} />
      )}
    </Sheet>
  );
}

export default function Meetings() {
  const { c } = useTheme();
  const { openCreate } = useShell();
  const [range, setRange] = useState<'upcoming' | 'past'>('upcoming');
  const [subscribe, setSubscribe] = useState(false);
  const { data, error, reload, refresh, refreshing } = useApi<Meeting[]>(`/meetings${qs({ range })}`);
  useRealtime((e) => e.type === 'meeting.updated' && reload());
  useReloadOnFocus(reload);
  const groups = new Map<string, Meeting[]>();
  for (const m of data ?? []) {
    const key = new Date(m.starts_at).toDateString();
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return (
    <>
      <Stack.Screen
        options={{
          title: 'Meetings',
          headerRight: () => (
            <Row gap={0}>
              <IconButton name="calendar" label="Add to my calendar" onPress={() => setSubscribe(true)} />
              <IconButton name="plus" label="Schedule a meeting" color={c.accentInk} onPress={() => openCreate('meeting')} />
            </Row>
          ),
        }}
      />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        <Muted size={14}>Agendas, notes, decisions and follow-ups — connected to the work they concern.</Muted>
        <Tabs
          value={range}
          onChange={setRange}
          tabs={[
            { id: 'upcoming', label: 'Upcoming' },
            { id: 'past', label: 'Past' },
          ]}
        />
        {error && !data ? (
          <ErrorState error={error} retry={reload} />
        ) : !data ? (
          <Loading inline />
        ) : !data.length ? (
          <Empty icon="video" title={range === 'upcoming' ? 'No upcoming meetings' : 'No past meetings'} action={range === 'upcoming' ? <Button variant="primary" icon="plus" title="Schedule a meeting" onPress={() => openCreate('meeting')} /> : undefined}>
            Schedule from here, a channel or a project.
          </Empty>
        ) : (
          [...groups.entries()].map(([day, list]) => (
            <View key={day} style={{ gap: 8 }}>
              <Eyebrow>{new Date(day).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</Eyebrow>
              <Card padded={false} style={{ paddingHorizontal: 14 }}>
                {list.map((m, i) => {
                  const live = !!m.started_at && !m.ended_at;
                  return (
                    <Pressable key={m.id} onPress={() => router.push(`/meetings/${m.id}`)} accessibilityRole="button" style={{ flexDirection: 'row', gap: 12, paddingVertical: 12, borderTopWidth: i ? 1 : 0, borderColor: c.line2 }}>
                      <View style={{ width: 62 }}>
                        <T weight="bold">{timeOf(m.starts_at)}</T>
                        <Muted size={12}>{m.duration_min} min</Muted>
                      </View>
                      <View style={{ width: 3, borderRadius: 2, backgroundColor: live ? c.red : swatch(m.project?.color ?? 'purple') }} />
                      <View style={{ flex: 1, gap: 4 }}>
                        <Row>
                          <T weight="semibold" style={{ flex: 1 }}>
                            {m.title}
                          </T>
                          {live && <Pill label="Live" tone="red" />}
                        </Row>
                        <Row gap={5}>
                          {!!m.video_url && <Icon name="video" size={13} color={c.muted} />}
                          <Muted size={12} numberOfLines={1}>
                            {m.project?.name ?? m.location ?? ''} · organised by {m.organizer?.name}
                          </Muted>
                        </Row>
                        <AvatarStack users={m.participants} max={5} />
                      </View>
                    </Pressable>
                  );
                })}
              </Card>
            </View>
          ))
        )}
      </Screen>
      <CalendarSubscribe open={subscribe} onClose={() => setSubscribe(false)} />
    </>
  );
}
