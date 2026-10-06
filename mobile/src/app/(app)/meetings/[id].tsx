import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { api, type Decision, type Meeting, type Task } from '@/lib/api';
import { dateTime, localTimeIn, timeOf } from '@/lib/format';
import { shareApiDownload } from '@/lib/files';
import { useApi, useRealtime } from '@/lib/hooks';
import { useShell } from '@/lib/shell';
import { useTheme } from '@/lib/theme';
import { AiDraft, useAiEnabled } from '@/ui/chat';
import { NewTaskForm } from '@/ui/create';
import { Icon } from '@/ui/Icon';
import { ActionSheet, Avatar, Button, Card, confirm, ErrorState, Eyebrow, H1, IconButton, Input, LinkText, ListRow, Loading, Muted, Pill, Row, Screen, Section, Segmented, Sheet, T, useAction } from '@/ui/kit';
import { Markdown, openLink } from '@/ui/Markdown';
import { PeopleField } from '@/ui/pickers';
import { MeetingRecordings } from '@/ui/recorder';
import { TaskList } from '@/ui/work';

interface MeetingFull extends Meeting {
  agenda: string;
  notes: string;
  tasks: Task[];
  decisions: Decision[];
  channel: { id: string; name: string; kind: string } | null;
  my_response: string | null;
  can_manage: boolean;
  can_take_notes: boolean;
}

export default function MeetingDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const { openTask } = useShell();
  const act = useAction();
  const { data: m, error, reload, refresh, refreshing } = useApi<MeetingFull>(`/meetings/${id}`);
  const [notes, setNotes] = useState<string | null>(null);
  const [agenda, setAgenda] = useState<string | null>(null);
  const [addingTask, setAddingTask] = useState(false);
  const [decision, setDecision] = useState('');
  const [editPeople, setEditPeople] = useState<string[] | null>(null);
  const [menu, setMenu] = useState(false);
  const aiEnabled = useAiEnabled();
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  useRealtime((e) => e.type === 'meeting.updated' && e.meetingId === id && notes === null && agenda === null && reload());
  if (error && !m) return <ErrorState error={error} retry={reload} />;
  if (!m) return <Loading />;
  const live = !!m.started_at && !m.ended_at;
  const zones = [...new Set(m.participants.map((p) => p.timezone).filter((tz) => tz && tz !== Intl.DateTimeFormat().resolvedOptions().timeZone))];
  const saveNotes = async () => {
    if (notes === null || notes === m.notes) return setNotes(null);
    await act(() => api.patch(`/meetings/${m.id}`, { notes }), 'Notes saved');
    setNotes(null);
    reload();
  };
  const saveAgenda = async () => {
    if (agenda === null || agenda === m.agenda) return setAgenda(null);
    await act(() => api.patch(`/meetings/${m.id}`, { agenda }), 'Agenda saved');
    setAgenda(null);
    reload();
  };
  return (
    <>
      <Stack.Screen options={{ title: m.project?.name ?? 'Meeting', headerRight: () => <IconButton name="more" label="Meeting options" onPress={() => setMenu(true)} /> }} />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        <Card style={{ gap: 10 }}>
          <Eyebrow style={live ? { color: c.red } : undefined}>{live ? 'Happening now' : m.ended_at ? 'Ended' : 'Scheduled'}</Eyebrow>
          <H1>{m.title}</H1>
          <Muted size={14}>
            {dateTime(m.starts_at)} – {timeOf(m.ends_at)} · {m.duration_min} min{m.location ? ` · ${m.location}` : ''}
          </Muted>
          {zones.length > 0 && <Muted size={12}>{zones.map((tz) => `${new Date(m.starts_at).toLocaleTimeString(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' })} ${tz}`).join(' · ')}</Muted>}
          {!!m.video_url && !m.ended_at && (
            <Button
              variant="primary"
              icon="video"
              full
              title={live ? 'Join now' : 'Start & join video'}
              onPress={() => {
                if (m.can_take_notes && !m.started_at) api.post(`/meetings/${m.id}/start`).then(reload).catch(() => {});
                openLink(m.video_url);
              }}
            />
          )}
          {m.my_response && !m.ended_at && (
            <Segmented
              value={m.my_response}
              onChange={async (v) => {
                await act(() => api.post(`/meetings/${m.id}/respond`, { response: v }), 'Response saved');
                reload();
              }}
              options={[
                { id: 'accepted', label: 'Going' },
                { id: 'declined', label: 'Not going' },
                { id: 'pending', label: 'Maybe later' },
              ]}
            />
          )}
          {m.can_take_notes && !m.ended_at && (
            <Button
              icon="check"
              full
              title="End & share follow-ups"
              onPress={async () => {
                if (!(await confirm('End the meeting?', 'Notes, decisions and follow-ups are sent to participants.', 'End meeting', false))) return;
                await act(() => api.post(`/meetings/${m.id}/end`), 'Meeting wrapped up');
                reload();
              }}
            />
          )}
        </Card>

        <MeetingRecordings meetingId={m.id} meetingTitle={m.title} />

        <Section title="Agenda" action={m.can_take_notes && agenda === null ? <LinkText onPress={() => setAgenda(m.agenda)}>Edit</LinkText> : undefined}>
          {agenda !== null ? (
            <View style={{ gap: 8 }}>
              <Input multiline value={agenda} onChangeText={setAgenda} autoFocus accessibilityLabel="Agenda" style={{ minHeight: 140 }} />
              <Row style={{ justifyContent: 'flex-end' }}>
                <Button small title="Cancel" onPress={() => setAgenda(null)} />
                <Button small variant="primary" title="Save" onPress={saveAgenda} />
              </Row>
            </View>
          ) : m.agenda ? (
            <Markdown text={m.agenda} />
          ) : (
            <Muted>No agenda yet.</Muted>
          )}
        </Section>

        <Section
          title="Notes"
          action={
            <Row>
              {aiEnabled && (
                <Button
                  small
                  icon="spark"
                  title={aiBusy ? 'Drafting…' : 'Summary'}
                  disabled={aiBusy}
                  onPress={async () => {
                    setAiBusy(true);
                    const res = await act(() => api.post<{ summary: string }>(`/ai/meetings/${m.id}/summary`));
                    setAiBusy(false);
                    if (res) setAiSummary(res.summary);
                  }}
                />
              )}
              {m.can_take_notes && notes === null && <LinkText onPress={() => setNotes(m.notes)}>{m.notes ? 'Edit' : 'Take notes'}</LinkText>}
            </Row>
          }
        >
          {aiSummary && (
            <AiDraft
              text={aiSummary}
              useLabel="Add to notes"
              onUse={
                m.can_take_notes
                  ? async () => {
                      await act(() => api.patch(`/meetings/${m.id}`, { notes: `${m.notes ? `${m.notes}\n\n` : ''}## Summary\n\n${aiSummary}` }), 'Summary added to notes');
                      setAiSummary(null);
                      reload();
                    }
                  : undefined
              }
            />
          )}
          {notes !== null ? (
            <View style={{ gap: 8 }}>
              <Input multiline value={notes} onChangeText={setNotes} autoFocus accessibilityLabel="Meeting notes" placeholder="Capture discussion points. Record decisions and follow-ups below so they are tracked." style={{ minHeight: 220 }} />
              <Row style={{ justifyContent: 'flex-end' }}>
                <Button small title="Cancel" onPress={() => setNotes(null)} />
                <Button small variant="primary" title="Save notes" onPress={saveNotes} />
              </Row>
            </View>
          ) : m.notes ? (
            <Markdown text={m.notes} />
          ) : (
            <Muted>No notes yet.</Muted>
          )}
        </Section>

        <Section title="Decisions">
          {m.decisions.map((d) => (
            <ListRow
              key={d.id}
              left={
                <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: c.amberSoft, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="gavel" size={15} color={c.amberInk} />
                </View>
              }
              title={d.title}
              subtitle={d.decided_by_name}
            />
          ))}
          {!m.decisions.length && <Muted>No decisions recorded.</Muted>}
          {m.can_take_notes && (
            <Input
              value={decision}
              onChangeText={setDecision}
              placeholder="Record a decision"
              accessibilityLabel="New decision"
              returnKeyType="done"
              style={{ marginTop: 8 }}
              onSubmitEditing={async () => {
                if (!decision.trim()) return;
                await act(() => api.post('/decisions', { title: decision, meetingId: m.id }), 'Decision recorded');
                setDecision('');
                reload();
              }}
            />
          )}
        </Section>

        <Section title="Follow-up tasks" action={m.can_take_notes ? <Button small icon="plus" title="Add" onPress={() => setAddingTask(true)} /> : undefined}>
          <TaskList tasks={m.tasks} onOpen={(t) => openTask(t.id)} empty={<Muted>No follow-ups yet. Every action item should have one owner and a date.</Muted>} />
        </Section>

        <Section title="Participants" count={m.participants.length} action={m.can_manage && !m.ended_at ? <LinkText onPress={() => setEditPeople(m.participants.map((p) => p.id))}>Edit</LinkText> : undefined}>
          {m.participants.map((p) => (
            <ListRow
              key={p.id}
              left={<Avatar user={p} size="sm" presence />}
              title={
                <Row gap={6}>
                  <T weight="semibold">{p.name}</T>
                  {p.id === m.organizer?.id && <Pill label="Organizer" />}
                </Row>
              }
              subtitle={`${localTimeIn(p.timezone)} local time`}
              right={<Pill label={p.response === 'accepted' ? 'Going' : p.response === 'declined' ? 'Declined' : 'Pending'} tone={p.response === 'accepted' ? 'green' : p.response === 'declined' ? 'red' : 'neutral'} />}
              onPress={() => router.push(`/people/${p.id}`)}
            />
          ))}
        </Section>
      </Screen>
      <ActionSheet
        open={menu}
        onClose={() => setMenu(false)}
        title={m.title}
        actions={[
          { label: 'Add to calendar', icon: 'calendar', onPress: () => act(() => shareApiDownload(`/meetings/${m.id}/ics`, `${m.title}.ics`, 'text/calendar')) },
          { label: `Open #${m.channel?.name ?? ''}`, icon: 'hash', onPress: () => router.push(`/channels/${m.channel!.id}`), hidden: !m.channel },
          { label: 'Open project', icon: 'folder', onPress: () => router.push(`/projects/${m.project!.id}`), hidden: !m.project },
          {
            label: 'Cancel meeting',
            icon: 'trash',
            danger: true,
            hidden: !m.can_manage || !!m.ended_at,
            onPress: async () => {
              if (!(await confirm('Cancel this meeting?', 'Participants will be notified.', 'Cancel meeting'))) return;
              await act(() => api.del(`/meetings/${m.id}`), 'Meeting cancelled');
              router.back();
            },
          },
        ]}
      />
      <Sheet open={addingTask} onClose={() => setAddingTask(false)} title="Add a follow-up task" full>
        {addingTask && (
          <NewTaskForm
            projectId={m.project?.id}
            defaults={{ meetingId: m.id }}
            onDone={() => {
              setAddingTask(false);
              reload();
            }}
          />
        )}
      </Sheet>
      <Sheet
        open={editPeople !== null}
        onClose={() => setEditPeople(null)}
        title="Participants"
        footer={
          <Button
            title="Save"
            variant="primary"
            full
            onPress={async () => {
              await act(() => api.patch(`/meetings/${m.id}`, { participantIds: editPeople }), 'Participants updated');
              setEditPeople(null);
              reload();
            }}
          />
        }
      >
        {editPeople && <PeopleField value={editPeople} onChange={setEditPeople} title="Participants" />}
      </Sheet>
    </>
  );
}
