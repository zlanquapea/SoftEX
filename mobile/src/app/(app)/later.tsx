import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { api } from '@/lib/api';
import { dateTime, plainMentions } from '@/lib/format';
import { useApi, useRealtime } from '@/lib/hooks';
import { useTheme } from '@/lib/theme';
import { Icon } from '@/ui/Icon';
import { Button, Card, Empty, ErrorState, IconButton, LinkText, Loading, Muted, Row, Screen, T, Tabs, useAction } from '@/ui/kit';
import { WhenSheet } from '@/ui/work';

interface Reminder {
  id: string;
  remind_at: string;
  note: string;
  task_id: string | null;
  task_title: string | null;
  message_id: string | null;
  message_body: string | null;
  channel_id: string | null;
}
interface Scheduled {
  id: string;
  channel_id: string;
  channel_name: string;
  channel_kind: string;
  parent_id: string | null;
  body: string;
  send_at: string;
  failed_reason: string | null;
}

export default function Later() {
  const { c } = useTheme();
  const act = useAction();
  const [tab, setTab] = useState<'reminders' | 'scheduled'>('reminders');
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState<Scheduled | null>(null);
  const reminders = useApi<Reminder[]>('/reminders');
  const scheduled = useApi<Scheduled[]>('/scheduled-messages');
  useRealtime((e) => {
    if (e.type === 'notification' || e.type === 'message.created') {
      reminders.reload();
      scheduled.reload();
    }
  });
  return (
    <>
      <Stack.Screen options={{ title: 'Later', headerRight: () => <IconButton name="plus" label="New reminder" color={c.accentInk} onPress={() => setAdding(true)} /> }} />
      <Screen refreshing={reminders.refreshing || scheduled.refreshing} onRefresh={() => (reminders.refresh(), scheduled.refresh())}>
        <Muted size={14}>Nudges for your future self, and messages that go out at a better time for the people receiving them.</Muted>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'reminders', label: 'Reminders', count: reminders.data?.length },
            { id: 'scheduled', label: 'Scheduled messages', count: scheduled.data?.length },
          ]}
        />
        {tab === 'reminders' &&
          (reminders.error && !reminders.data ? (
            <ErrorState error={reminders.error} retry={reminders.reload} />
          ) : !reminders.data ? (
            <Loading inline />
          ) : !reminders.data.length ? (
            <Empty icon="clock" title="No reminders">
              Use “Remind me” on a message or task, or add a note here.
            </Empty>
          ) : (
            reminders.data.map((r) => (
              <Card key={r.id} style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
                <Icon name="clock" size={20} color={c.accentInk} />
                <View style={{ flex: 1, gap: 4 }}>
                  <T weight="bold">{dateTime(r.remind_at)}</T>
                  {!!r.note && <T size={14}>{r.note}</T>}
                  {r.task_id && (
                    <LinkText size={14} onPress={() => router.push(`/tasks/${r.task_id}`)}>
                      Task: {r.task_title}
                    </LinkText>
                  )}
                  {r.message_id && r.channel_id && (
                    <LinkText size={14} onPress={() => router.push(`/channels/${r.channel_id}?message=${r.message_id}`)}>
                      “{plainMentions(r.message_body ?? '').slice(0, 120)}”
                    </LinkText>
                  )}
                </View>
                <IconButton name="trash" label="Delete reminder" onPress={async () => (await act(() => api.del(`/reminders/${r.id}`), 'Reminder removed')) && reminders.reload()} />
              </Card>
            ))
          ))}
        {tab === 'scheduled' &&
          (scheduled.error && !scheduled.data ? (
            <ErrorState error={scheduled.error} retry={scheduled.reload} />
          ) : !scheduled.data ? (
            <Loading inline />
          ) : !scheduled.data.length ? (
            <Empty icon="send" title="Nothing scheduled">
              Write a message, then choose Send later from the + menu.
            </Empty>
          ) : (
            scheduled.data.map((s) => (
              <Card key={s.id} style={{ gap: 6, borderColor: s.failed_reason ? c.redLine : c.line }}>
                <Row style={{ alignItems: 'flex-start' }}>
                  <Icon name="send" size={18} color={c.accentInk} />
                  <View style={{ flex: 1 }}>
                    <T weight="bold">{dateTime(s.send_at)}</T>
                    <LinkText size={13} onPress={() => router.push(`/channels/${s.channel_id}`)}>
                      {s.channel_kind === 'dm' ? 'Direct message' : `#${s.channel_name}`}
                      {s.parent_id ? ' (thread reply)' : ''}
                    </LinkText>
                  </View>
                  <IconButton name="trash" label="Cancel scheduled message" onPress={async () => (await act(() => api.del(`/scheduled-messages/${s.id}`), 'Scheduled message cancelled')) && scheduled.reload()} />
                </Row>
                <T size={14}>{plainMentions(s.body).slice(0, 280)}</T>
                {s.failed_reason && (
                  <T size={13} tone="red">
                    Not sent: {s.failed_reason}
                  </T>
                )}
                <Button small title="Reschedule" onPress={() => setMoving(s)} />
              </Card>
            ))
          ))}
      </Screen>
      <WhenSheet
        open={adding}
        onClose={() => setAdding(false)}
        eyebrow="Reminder"
        title="New reminder"
        confirmLabel="Set reminder"
        withNote
        onPick={async (iso, note) => {
          const ok = await act(() => api.post('/reminders', { remindAt: iso, note }), 'Reminder set');
          if (ok) reminders.reload();
          return ok;
        }}
      />
      <WhenSheet
        open={!!moving}
        onClose={() => setMoving(null)}
        eyebrow="Send later"
        title="Reschedule message"
        confirmLabel="Reschedule"
        onPick={async (iso) => {
          const ok = await act(() => api.patch(`/scheduled-messages/${moving!.id}`, { sendAt: iso }), 'Rescheduled');
          if (ok) scheduled.reload();
          return ok;
        }}
      />
    </>
  );
}
