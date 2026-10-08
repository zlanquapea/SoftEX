import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useShell } from '@/lib/shell';
import { useTheme } from '@/lib/theme';
import { Icon } from '@/ui/Icon';
import { Card, LinkText, Muted, Row, Screen, SearchBox, T } from '@/ui/kit';
import { openLink } from '@/ui/Markdown';
import { usePublicPricing } from '@/screens/auth';

interface Topic {
  id: string;
  icon: string;
  title: string;
  items: { q: string; a: string; link?: { label: string; to: string } }[];
}

const TOPICS: Topic[] = [
  {
    id: 'start',
    icon: 'flag',
    title: 'Getting started',
    items: [
      { q: 'Where do I begin?', a: 'Home shows what matters today: tasks due, blocked work, meetings coming up and what changed since you last looked. Workspace owners also see a short “Get ready” checklist there until the team is set up.' },
      { q: 'How do I invite my team?', a: 'Admins and team leads use Invite people under More, or Administration → Invitations. You can paste a list of emails to invite many people at once.', link: { label: 'Open invitations', to: '/admin?tab=invitations' } },
      { q: 'Can I create things quickly from anywhere?', a: 'Tap + at the top of any tab to create a task, project, message, meeting or page, and the magnifier to search everything.' },
    ],
  },
  {
    id: 'chat',
    icon: 'chat',
    title: 'Chat and channels',
    items: [
      { q: 'Channels or chats?', a: 'Channels are for a team, project or topic, and everyone who joins sees the history. Chats are direct conversations with one or a few people.' },
      { q: 'Turn a message into work', a: 'Long-press a message and choose Create task to give it one owner and a due date, or Record decision. Both stay linked to the message.' },
      { q: 'Polls, voice notes and urgent messages', a: 'Tap + next to the message box to attach photos or files, start a poll or mark a message urgent; hold the microphone to record a voice note. Mark a message urgent only when it cannot wait: it reaches people even in quiet hours.' },
      { q: 'Too many notifications?', a: 'Mute a channel or switch it to mentions-only from its details (tap the channel name). Quiet hours and focus time are in Settings.' },
    ],
  },
  {
    id: 'work',
    icon: 'folder',
    title: 'Projects and tasks',
    items: [
      { q: 'Views', a: 'Each project has list, board, table and calendar views, a timeline, milestones, risks, decisions and check-ins. Workload shows who is overloaded.' },
      { q: 'Custom fields, labels and time', a: 'Project owners add fields (number, date, dropdown and more) from the project’s menu. Start a timer or log time on any task; Timesheet shows your week.' },
      { q: 'Intake forms', a: 'Under a project’s Forms tab, build a form that turns each response into a task. Share it with colleagues or publicly with a link.' },
      { q: 'Automations', a: 'Under Automations, set rules such as “when a task moves to review, assign the reviewer”. Nothing runs without a rule you can see.' },
    ],
  },
  {
    id: 'plan',
    icon: 'target',
    title: 'Goals and dashboards',
    items: [
      { q: 'Goals', a: 'Set a goal, add key results you can measure, and link the projects that move it. Progress updates as linked work is done.' },
      { q: 'Dashboards', a: 'Build a dashboard from charts of open work, overdue tasks, progress and trends. Everyone sees numbers only from the projects they can open.' },
    ],
  },
  {
    id: 'knowledge',
    icon: 'book',
    title: 'Knowledge, whiteboards and meetings',
    items: [
      { q: 'Pages that stay trustworthy', a: 'Every page has an owner and a review date, and approved pages show first in search. Several people can edit a page at once. Publish a page to the web from its menu.' },
      { q: 'Whiteboards', a: 'Brainstorm with sticky notes, shapes and connectors. Everyone on the board edits at the same time. Use two fingers to move around and pinch to zoom.' },
      { q: 'Meetings', a: 'Schedule from Meetings, a channel or a project, add an agenda, record from your phone, and capture decisions and follow-up tasks. Ending the meeting shares everything.' },
    ],
  },
  {
    id: 'privacy',
    icon: 'shield',
    title: 'Privacy and security',
    items: [
      { q: 'Who can see what?', a: 'Private channels and projects, and their files, never appear in search, activity, notifications or exports for people who are not members. Guests only see what you share.' },
      { q: 'Protect your account', a: 'Turn on two-step sign-in and review where you are signed in under Settings → Security. You can also export your data there.', link: { label: 'Open security settings', to: '/settings?tab=security' } },
    ],
  },
];

export default function Help() {
  const { c } = useTheme();
  const { openSearch } = useShell();
  const { data: pricing } = usePublicPricing();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const term = q.trim().toLowerCase();
  const topics = TOPICS.map((t) => ({ ...t, items: t.items.filter((i) => !term || `${t.title} ${i.q} ${i.a}`.toLowerCase().includes(term)) })).filter((t) => t.items.length);
  const contact = pricing?.support_email ?? pricing?.company.email;
  return (
    <>
      <Stack.Screen options={{ title: 'Help' }} />
      <Screen>
        <Muted size={14}>How to get the most out of Küü, one topic at a time.</Muted>
        <SearchBox value={q} onChangeText={setQ} placeholder="Search help" />
        {!topics.length && (
          <Row wrap gap={4}>
            <Muted>Nothing in help matches “{q}”.</Muted>
            <LinkText onPress={() => openSearch(q)}>Search your workspace instead</LinkText>
          </Row>
        )}
        {topics.map((t) => (
          <Card key={t.id} padded={false} style={{ paddingHorizontal: 14, paddingTop: 12 }}>
            <Row gap={8}>
              <Icon name={t.icon} size={18} color={c.accentInk} />
              <T size={17} weight="display">
                {t.title}
              </T>
            </Row>
            {t.items.map((i) => {
              const key = `${t.id}:${i.q}`;
              const shown = !!term || open === key;
              return (
                <View key={key} style={{ borderTopWidth: 1, borderColor: c.line2, marginTop: 8 }}>
                  <Pressable onPress={() => setOpen(open === key ? null : key)} accessibilityRole="button" accessibilityState={{ expanded: shown }} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 }}>
                    <T weight="semibold" style={{ flex: 1 }}>
                      {i.q}
                    </T>
                    <Icon name={shown ? 'chevronDown' : 'chevronRight'} size={16} color={c.muted} />
                  </Pressable>
                  {shown && (
                    <View style={{ gap: 6, paddingBottom: 12 }}>
                      <T size={14} tone="ink2">
                        {i.a}
                      </T>
                      {i.link && <LinkText onPress={() => router.push(i.link!.to as never)}>{i.link.label}</LinkText>}
                    </View>
                  )}
                </View>
              );
            })}
          </Card>
        ))}
        <Card style={{ gap: 6 }}>
          <Row gap={8}>
            <Icon name="help" size={18} color={c.accentInk} />
            <T size={17} weight="display">
              Still stuck?
            </T>
          </Row>
          <Row wrap gap={4}>
            <Muted>Ask your workspace admin, or</Muted>
            {contact ? <LinkText onPress={() => openLink(`mailto:${contact}`)}>email us at {contact}</LinkText> : <Muted>contact whoever runs your Küü server.</Muted>}
          </Row>
          <Muted size={12}>Messages and pages support **bold**, *italic*, `code`, lists, &gt; quotes, links and @mentions.</Muted>
        </Card>
      </Screen>
    </>
  );
}
