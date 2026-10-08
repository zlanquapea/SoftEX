import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api, type Activity, type Decision, type Notification, type Task } from '@/lib/api';
import { plainMentions, timeAgo, timeOf } from '@/lib/format';
import { useApi, useRealtime, useReloadOnFocus } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useShell } from '@/lib/shell';
import { storage } from '@/lib/storage';
import { swatch, useTheme } from '@/lib/theme';
import { Icon } from '@/ui/Icon';
import { Avatar, AvatarStack, Button, Card, Checkbox, ErrorState, Eyebrow, H1, HealthPill, LinkText, ListRow, Loading, Muted, ProgressBar, Row, Screen, Section, Sheet, T, Toggle, useAction } from '@/ui/kit';
import { AccountBanners } from '@/ui/plan';
import { TaskList } from '@/ui/work';
import { CheckinSheet } from '@/ui/checkin';

interface HomeData {
  since: string;
  first_visit?: boolean;
  setup?: { id: SetupStepId; done: boolean }[] | null;
  focus: Task[];
  up_next: Task[];
  blocked: Task[];
  meetings: {
    id: string;
    title: string;
    starts_at: string;
    duration_min: number;
    location: string;
    video_url: string;
    started_at: string | null;
    participants: { id: string; name: string; color: string }[];
  }[];
  mentions: (Notification & { actor_name: string; actor_color: string })[];
  decisions: (Decision & { project_name: string | null })[];
  changes: Activity[];
  projects: { id: string; name: string; color: string; health: string; progress: number; members: { id: string; name: string; color: string }[]; member_count: number }[];
  onboarding: { total: number; done: number };
  pending_approvals: number;
  checked_in_today: boolean;
  reviews_due: { id: string; title: string; review_date: string }[];
  counts: { open_tasks: number; overdue: number; unread: number };
}

const OPTIONAL = [
  { id: 'projects', label: 'Active projects' },
  { id: 'decisions', label: 'Recent decisions' },
  { id: 'changes', label: 'What changed' },
  { id: 'upnext', label: 'Up next tasks' },
] as const;
type HomeSection = (typeof OPTIONAL)[number]['id'];
const HIDDEN_KEY = 'kuu.home.hidden';

export default function Home() {
  const { c } = useTheme();
  const { me } = useSession();
  const { openTask, openCreate } = useShell();
  const act = useAction();
  const { data, error, reload, refresh, refreshing } = useApi<HomeData>('/home');
  const [hidden, setHidden] = useState<HomeSection[]>([]);
  const [tuning, setTuning] = useState(false);
  const [checkin, setCheckin] = useState(false);

  useRealtime((e) => {
    if (['task.updated', 'notification', 'meeting.updated', 'reconnected'].includes(e.type)) reload();
  });
  useReloadOnFocus(reload);

  useEffect(() => {
    storage.get(HIDDEN_KEY).then((v) => {
      try {
        if (v) setHidden(JSON.parse(v));
      } catch {
        /* ignore */
      }
    });
    // "Since you last checked" moves forward after Home has been seen for a moment.
    const t = setTimeout(() => api.post('/home/seen').catch(() => {}), 5000);
    return () => clearTimeout(t);
  }, []);

  const toggleSection = (id: HomeSection) => {
    const next = hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id];
    setHidden(next);
    storage.set(HIDDEN_KEY, JSON.stringify(next));
  };

  if (error && !data) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading />;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = me!.user.name.split(' ')[0];
  const complete = async (t: Task, done: boolean) => {
    await act(() => api.patch(`/tasks/${t.id}`, { status: done ? 'done' : 'todo' }), done ? 'Task marked complete' : 'Task reopened');
    reload();
  };
  const show = (id: HomeSection) => !hidden.includes(id);

  const nudges: { key: string; icon: string; text: string; warn?: boolean; onPress: () => void }[] = [];
  if (data.onboarding.total > 0 && data.onboarding.done < data.onboarding.total)
    nudges.push({ key: 'onb', icon: 'flag', text: `Onboarding: ${data.onboarding.done} of ${data.onboarding.total} steps done`, onPress: () => router.push('/settings?tab=onboarding') });
  if (data.pending_approvals > 0)
    nudges.push({ key: 'appr', icon: 'inboxCheck', warn: true, text: `${data.pending_approvals} request${data.pending_approvals > 1 ? 's' : ''} waiting for your approval`, onPress: () => router.push('/requests') });
  if (!data.checked_in_today && me!.role !== 'guest') nudges.push({ key: 'checkin', icon: 'target', text: 'Share today’s check-in', onPress: () => setCheckin(true) });
  for (const p of data.reviews_due) nudges.push({ key: p.id, icon: 'book', warn: true, text: `“${p.title}” is due for review`, onPress: () => router.push(`/knowledge/${p.id}`) });

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <View style={{ gap: 4 }}>
        <Eyebrow>{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</Eyebrow>
        <H1>
          {greeting}, {first} 👋
        </H1>
        <Muted size={14}>
          {data.counts.open_tasks} open task{data.counts.open_tasks === 1 ? '' : 's'}
          {data.counts.overdue ? `, ${data.counts.overdue} overdue` : ''} · {data.meetings.length} meeting{data.meetings.length === 1 ? '' : 's'} coming up · {data.counts.unread} unread
        </Muted>
        <Row style={{ marginTop: 8 }}>
          <Button title="Create new" icon="plus" variant="primary" small onPress={() => openCreate()} />
          <Button title="Customize" icon="settings" small onPress={() => setTuning(true)} />
        </Row>
      </View>

      <AccountBanners />

      {nudges.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} style={{ marginHorizontal: -16 }} contentInset={{ left: 16, right: 16 }}>
          <View style={{ width: 8 }} />
          {nudges.map((n) => (
            <Pressable
              key={n.key}
              onPress={n.onPress}
              accessibilityRole="button"
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, height: 38, borderRadius: 19, backgroundColor: n.warn ? c.amberSoft : c.surface, borderWidth: 1, borderColor: n.warn ? c.amberLine : c.line }}
            >
              <Icon name={n.icon} size={15} color={n.warn ? c.amberInk : c.accentInk} />
              <T size={13} weight="semibold" tone={n.warn ? 'amber' : 'ink2'}>
                {n.text}
              </T>
            </Pressable>
          ))}
          <View style={{ width: 8 }} />
        </ScrollView>
      )}

      {data.setup && <SetupGuide steps={data.setup} />}

      <Section title="Today’s focus" action={<LinkText onPress={() => router.push('/my-work')}>View all</LinkText>}>
        <Muted style={{ marginTop: -6, marginBottom: 4 }}>{data.focus.length ? `${data.focus.length} task${data.focus.length > 1 ? 's' : ''} need your attention` : 'Nothing due today. Nice.'}</Muted>
        <TaskList tasks={data.focus} onOpen={(t) => openTask(t.id)} onToggle={complete} />
        <Pressable onPress={() => openCreate('task')} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10 }} accessibilityRole="button">
          <Icon name="plus" size={16} color={c.accentInk} />
          <T weight="semibold" tone="accent">
            Add a task
          </T>
        </Pressable>
      </Section>

      {data.blocked.length > 0 && (
        <Card style={{ borderColor: c.redLine, backgroundColor: c.surface }}>
          <Row gap={6} style={{ marginBottom: 2 }}>
            <Icon name="alert" size={18} color={c.red} />
            <T size={17} weight="display">
              Blocked
            </T>
          </Row>
          <Muted>Work that cannot move until something changes</Muted>
          <TaskList tasks={data.blocked} onOpen={(t) => openTask(t.id)} />
        </Card>
      )}

      <Section title="Meetings" action={<LinkText onPress={() => router.push('/meetings')}>Open meetings</LinkText>}>
        <Muted style={{ marginTop: -6, marginBottom: 6 }}>Next 36 hours</Muted>
        {data.meetings.map((m) => {
          const t = timeOf(m.starts_at);
          return (
            <Pressable key={m.id} onPress={() => router.push(`/meetings/${m.id}`)} style={{ flexDirection: 'row', gap: 12, paddingVertical: 10 }} accessibilityRole="button">
              <View style={{ width: 48, alignItems: 'flex-end' }}>
                <T weight="bold">{t.replace(/\s?[AP]M/i, '')}</T>
                <Muted size={11}>{t.match(/[AP]M/i)?.[0] ?? ''}</Muted>
              </View>
              <View style={{ width: 3, borderRadius: 2, backgroundColor: m.started_at ? c.red : c.accentLine }} />
              <View style={{ flex: 1, gap: 4 }}>
                <T weight="semibold">{m.title}</T>
                <Row gap={5}>
                  <Icon name={m.video_url ? 'video' : 'calendar'} size={13} color={c.muted} />
                  <Muted size={12}>
                    {m.started_at ? 'Live now' : new Date(m.starts_at).toDateString() === new Date().toDateString() ? 'Today' : 'Tomorrow'} · {m.duration_min} min
                  </Muted>
                </Row>
                <AvatarStack users={m.participants} />
              </View>
            </Pressable>
          );
        })}
        {!data.meetings.length && <Muted>No meetings coming up.</Muted>}
      </Section>

      <Section title="Mentions & messages">
        {data.mentions.map((n) => (
          <ListRow
            key={n.id}
            left={<Avatar user={{ name: n.actor_name ?? '?', color: n.actor_color }} size="sm" />}
            title={<T size={14}>{n.title}</T>}
            subtitle={
              <View>
                {!!n.body && (
                  <Muted size={13} numberOfLines={2}>
                    “{plainMentions(n.body).slice(0, 90)}”
                  </Muted>
                )}
                <Muted size={11}>{timeAgo(n.created_at)}</Muted>
              </View>
            }
            onPress={() => {
              api.post(`/notifications/${n.id}/read`).catch(() => {});
              if (n.link) router.push(n.link as never);
            }}
          />
        ))}
        {!data.mentions.length && <Muted>You are all caught up.</Muted>}
      </Section>

      {show('upnext') && data.up_next.length > 0 && (
        <Section title="Up next">
          <TaskList tasks={data.up_next} onOpen={(t) => openTask(t.id)} onToggle={complete} />
        </Section>
      )}

      {show('projects') && (
        <Section title="Active projects" action={<LinkText onPress={() => router.push('/projects')}>All projects</LinkText>}>
          {data.projects.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
              {data.projects.map((p) => (
                <Pressable
                  key={p.id}
                  onPress={() => router.push(`/projects/${p.id}`)}
                  accessibilityRole="button"
                  style={({ pressed }) => ({ width: 220, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: c.line, backgroundColor: pressed ? c.hover : c.surface2, gap: 8 })}
                >
                  <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: swatch(p.color), alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="folder" size={17} color="#fff" />
                  </View>
                  <T weight="bold" numberOfLines={1}>
                    {p.name}
                  </T>
                  <Muted size={12}>
                    {p.member_count} member{p.member_count === 1 ? '' : 's'}
                  </Muted>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <Muted size={12}>Progress</Muted>
                    <T size={12} weight="bold">
                      {p.progress}%
                    </T>
                  </Row>
                  <ProgressBar value={p.progress} color={swatch(p.color)} />
                  <Row style={{ justifyContent: 'space-between' }}>
                    <AvatarStack users={p.members} total={p.member_count} />
                    <HealthPill health={p.health} />
                  </Row>
                </Pressable>
              ))}
            </ScrollView>
          ) : (
            <Row wrap gap={4}>
              <Muted size={14}>You are not in any projects yet.</Muted>
              {me!.role !== 'guest' && <LinkText onPress={() => openCreate('project')}>Start one</LinkText>}
            </Row>
          )}
        </Section>
      )}

      {show('decisions') && (
        <Section title="Recent decisions" action={<LinkText onPress={() => router.push('/decisions')}>All</LinkText>}>
          {data.decisions.map((d) => (
            <ListRow
              key={d.id}
              left={
                <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: c.amberSoft, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="gavel" size={15} color={c.amberInk} />
                </View>
              }
              title={d.title}
              subtitle={`${d.decided_by_name} · ${d.project_name ?? 'Workspace'} · ${timeAgo(d.created_at)}`}
            />
          ))}
          {!data.decisions.length && <Muted>No decisions recorded yet.</Muted>}
        </Section>
      )}

      {show('changes') && (
        <Section title="What changed">
          <Muted style={{ marginTop: -6, marginBottom: 4 }}>{data.first_visit ? 'Recent activity in your workspace' : `Since you last checked · ${timeAgo(data.since)}`}</Muted>
          {data.changes.map((a) => (
            <ListRow
              key={a.id}
              left={<Avatar user={{ id: a.actor_id, name: a.actor_name, color: a.actor_color }} size="sm" />}
              title={
                <T size={14}>
                  <T size={14} weight="bold">
                    {a.actor_name.split(' ')[0]}
                  </T>{' '}
                  {a.summary}
                </T>
              }
              subtitle={timeAgo(a.created_at)}
              onPress={a.link ? () => router.push(a.link as never) : undefined}
            />
          ))}
          {!data.changes.length && <Muted>Nothing new since your last visit.</Muted>}
        </Section>
      )}

      <Sheet open={tuning} onClose={() => setTuning(false)} title="Customize Home" eyebrow="Your view">
        <Muted>Choose what Home shows. Today’s focus, blocked work, meetings and unread mentions always stay visible.</Muted>
        {OPTIONAL.map((o) => (
          <Toggle key={o.id} label={o.label} value={!hidden.includes(o.id)} onChange={() => toggleSection(o.id)} />
        ))}
      </Sheet>
      <CheckinSheet open={checkin} onClose={() => setCheckin(false)} onDone={reload} />
    </Screen>
  );
}

type SetupStepId = 'verify' | 'invite' | 'project' | 'message' | 'page' | 'meeting';

const SETUP_STEPS: Record<SetupStepId, { title: string; text: string; cta: string; to?: string; create?: 'project' | 'page' | 'meeting' }> = {
  verify: { title: 'Confirm your email address', text: 'Use the link we emailed you, so you can invite people and choose a plan.', cta: 'Resend link' },
  invite: { title: 'Invite your team', text: 'Küü is better together. Add colleagues by email, or invite partners as guests.', cta: 'Invite people', to: '/admin?tab=invitations' },
  project: { title: 'Create your first project', text: 'Give one real piece of work a home: its tasks, chat and documents together.', cta: 'New project', create: 'project' },
  message: { title: 'Say hello in a channel', text: 'Post the first message so your team finds a conversation when they arrive.', cta: 'Open channels', to: '/channels' },
  page: { title: 'Write down how you work', text: 'Start the knowledge base with one page: a policy, a how-to or a welcome note.', cta: 'New page', create: 'page' },
  meeting: { title: 'Schedule a meeting', text: 'Add an agenda and capture decisions and follow-ups as you talk.', cta: 'New meeting', create: 'meeting' },
};

function SetupGuide({ steps }: { steps: { id: SetupStepId; done: boolean }[] }) {
  const { c } = useTheme();
  const { me } = useSession();
  const { openCreate } = useShell();
  const act = useAction();
  const key = `kuu.setup-hidden.${me?.workspace.id}`;
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    storage.get(key).then((v) => setHidden(v === '1'));
  }, [key]);
  if (hidden) return null;
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done)?.id;
  return (
    <Card style={{ borderColor: c.accentLine }}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T size={17} weight="display">
            Get {me?.workspace.name} ready
          </T>
          <Muted>
            {done} of {steps.length} done — a few minutes now saves your team a lot of time later.
          </Muted>
        </View>
        <Button
          small
          title="Hide"
          onPress={() => {
            storage.set(key, '1');
            setHidden(true);
          }}
        />
      </Row>
      <ProgressBar value={(done / steps.length) * 100} style={{ marginVertical: 12 }} />
      <View style={{ gap: 12 }}>
        {steps.map((s) => {
          const step = SETUP_STEPS[s.id];
          const primary = s.id === next;
          return (
            <Row key={s.id} gap={10} style={{ alignItems: 'flex-start' }}>
              <Checkbox checked={s.done} disabled />
              <View style={{ flex: 1, gap: 2 }}>
                <T weight="semibold" tone={s.done ? 'muted' : 'ink'} style={s.done ? { textDecorationLine: 'line-through' } : undefined}>
                  {step.title}
                </T>
                {!s.done && <Muted size={12}>{step.text}</Muted>}
                {!s.done && (
                  <Button
                    small
                    variant={primary ? 'primary' : 'secondary'}
                    title={step.cta}
                    style={{ marginTop: 4 }}
                    onPress={() => {
                      if (step.to) router.push(step.to as never);
                      else if (step.create) openCreate(step.create);
                      else act(() => api.post('/me/verify-email/resend'), 'Confirmation email sent');
                    }}
                  />
                )}
              </View>
            </Row>
          );
        })}
      </View>
    </Card>
  );
}

