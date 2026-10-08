import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { api, qs } from '@/lib/api';
import { dateTime, plainMentions, timeAgo } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { swatch, useTheme } from '@/lib/theme';
import { useAiEnabled } from '@/ui/chat';
import { Icon } from '@/ui/Icon';
import { Avatar, Button, Card, Checkbox, Eyebrow, ListRow, Loading, Muted, Pill, Row, Screen, SearchBox, Select, StatusPill, T, Tabs } from '@/ui/kit';

interface AskResult {
  question: string;
  answer: string;
  sources: { n: number; type: string; title: string; link: string; snippet: string; date: string | null }[];
}
const SOURCE_ICON: Record<string, string> = { message: 'chat', page: 'book', decision: 'gavel', task: 'task', file: 'file', meeting: 'video' };
type SearchType = 'all' | 'messages' | 'tasks' | 'projects' | 'pages' | 'files' | 'people' | 'decisions' | 'meetings';
const TYPES: { id: SearchType; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'messages', label: 'Messages' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'pages', label: 'Knowledge' },
  { id: 'files', label: 'Files' },
  { id: 'projects', label: 'Projects' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'meetings', label: 'Meetings' },
  { id: 'people', label: 'People' },
];
const citedSources = (a: AskResult) => {
  const cited = new Set([...a.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  return cited.size ? a.sources.filter((s) => cited.has(s.n)) : a.sources;
};

/** Search everything you can access, and ask Küü a question when AI is on. */
export default function Search() {
  const { c } = useTheme();
  const params = useLocalSearchParams<{ q?: string }>();
  const { people } = useSession();
  const aiEnabled = useAiEnabled();
  const [q, setQ] = useState(params.q ?? '');
  const [type, setType] = useState<SearchType>('all');
  const [from, setFrom] = useState('');
  const [hasFile, setHasFile] = useState(false);
  const [results, setResults] = useState<Record<string, any[]> | null>(null);
  const [loading, setLoading] = useState(false);
  const [ask, setAsk] = useState<AskResult | { question: string; loading: true } | { question: string; error: string } | null>(null);
  const debounced = useDebounced(q, 250);

  useEffect(() => {
    if (debounced.trim().length < 2 && !from && !hasFile) {
      setResults(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .get(`/search${qs({ q: debounced.trim(), type, from, hasFile: hasFile ? 'true' : undefined, limit: type === 'all' ? 5 : 25 })}`)
      .then((r) => !cancelled && setResults(r))
      .catch(() => !cancelled && setResults(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [debounced, type, from, hasFile]);

  const runAsk = async () => {
    const question = q.trim();
    if (question.length < 3) return;
    setAsk({ question, loading: true });
    try {
      const res = await api.post<Omit<AskResult, 'question'>>('/ai/ask', { question });
      setAsk({ question, ...res });
    } catch (e) {
      setAsk({ question, error: (e as Error).message });
    }
  };
  const go = (path: string) => router.push(path as never);
  const total = results ? Object.values(results).reduce((n, list) => n + list.length, 0) : 0;
  const section = (key: string, title: string, render: (item: any) => ReactNode) =>
    results && results[key]?.length ? (
      <View key={key} style={{ gap: 4 }}>
        <Eyebrow>{title}</Eyebrow>
        <Card padded={false} style={{ paddingHorizontal: 14 }}>
          {results[key].map(render)}
        </Card>
      </View>
    ) : null;

  return (
    <>
      <Stack.Screen options={{ title: 'Search' }} />
      <Screen>
        <SearchBox value={q} onChangeText={setQ} placeholder={aiEnabled ? 'Search, or ask a question' : 'Search messages, tasks, files, knowledge and people'} autoFocus />
        <Tabs value={type} onChange={setType} tabs={TYPES} />
        {(type === 'messages' || type === 'all' || type === 'tasks') && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, alignItems: 'center' }}>
            <View style={{ width: 170 }}>
              <Select title="From" value={from} onChange={setFrom} options={[{ id: '', label: 'Anyone' }, ...people.map((p) => ({ id: p.id, label: p.name }))]} />
            </View>
            {(type === 'messages' || type === 'all') && <Checkbox checked={hasFile} onChange={setHasFile} label="Has attachment" />}
          </ScrollView>
        )}
        {aiEnabled && q.trim().length >= 3 && (!ask || ask.question !== q.trim()) && (
          <Card onPress={runAsk} style={{ flexDirection: 'row', gap: 10, borderColor: c.blueLine, backgroundColor: c.blueSoft }}>
            <Icon name="spark" size={20} color={c.blueInk} />
            <View style={{ flex: 1 }}>
              <T weight="bold">Ask Küü: “{q.trim()}”</T>
              <Muted size={12}>Get an answer with sources from messages, knowledge, decisions and files you can access.</Muted>
            </View>
          </Card>
        )}
        {ask && (
          <Card style={{ gap: 8, borderColor: c.blueLine }}>
            <Row gap={6}>
              <Icon name="spark" size={14} color={c.blueInk} />
              <T weight="bold" style={{ flex: 1 }}>
                {ask.question}
              </T>
            </Row>
            {'loading' in ask && <Loading inline label="Reading what you have access to" />}
            {'error' in ask && <T tone="red">{ask.error}</T>}
            {'answer' in ask && (
              <>
                {ask.answer.split(/\n{2,}/).map((para, i) => (
                  <T key={i} size={15}>
                    {para.split(/(\[\d+\])/g).map((part, j) => {
                      const m = part.match(/^\[(\d+)\]$/);
                      const src = m ? ask.sources.find((s) => s.n === Number(m[1])) : undefined;
                      return src ? (
                        <T key={j} size={13} weight="bold" tone="blue" onPress={() => go(src.link)}>
                          {` [${src.n}] `}
                        </T>
                      ) : (
                        part
                      );
                    })}
                  </T>
                ))}
                {citedSources(ask).map((s) => (
                  <ListRow
                    key={s.n}
                    left={<Pill label={String(s.n)} tone="blue" />}
                    title={
                      <Row gap={6}>
                        <Icon name={SOURCE_ICON[s.type] ?? 'file'} size={13} color={c.ink2} />
                        <T size={14} weight="semibold" style={{ flex: 1 }} numberOfLines={1}>
                          {s.title}
                        </T>
                      </Row>
                    }
                    subtitle={s.date ? timeAgo(s.date) : undefined}
                    onPress={() => go(s.link)}
                  />
                ))}
                <Muted size={11}>AI answer — check the sources before relying on it. Only you can see this.</Muted>
              </>
            )}
          </Card>
        )}
        {loading && <Loading inline />}
        {!results && !loading && <Muted>Type at least two characters. Results only include items you have access to.</Muted>}
        {results && total === 0 && !loading && <Muted>No results for “{debounced}”.</Muted>}
        {section('pages', 'Knowledge', (p) => (
          <ListRow
            key={p.id}
            left={<Icon name="book" size={18} color={c.ink2} />}
            title={
              <Row gap={6}>
                <T weight="semibold" style={{ flexShrink: 1 }} numberOfLines={1}>
                  {p.title}
                </T>
                {p.status === 'approved' && <Pill label="Approved" tone="green" />}
              </Row>
            }
            subtitle={`${p.owner_name} · ${p.review_date ? `review ${p.review_date}` : `updated ${timeAgo(p.updated_at)}`}${p.snippet ? `\n…${p.snippet.replace(/[#*_>`]/g, '').replace(/\s+/g, ' ')}…` : ''}`}
            onPress={() => go(`/knowledge/${p.id}`)}
          />
        ))}
        {section('messages', 'Messages', (m) => (
          <ListRow
            key={m.id}
            left={<Avatar user={{ name: m.user_name, color: m.user_color }} size="sm" />}
            title={
              <T size={14} weight="semibold" numberOfLines={1}>
                {m.user_name} <T size={12} tone="muted">in {m.channel_kind === 'dm' ? 'direct message' : `#${m.channel_name}`}</T>
              </T>
            }
            subtitle={`${plainMentions(m.body).slice(0, 180)} · ${timeAgo(m.created_at)}`}
            onPress={() => go(`/channels/${m.channel_id}?message=${m.parent_id ?? m.id}`)}
          />
        ))}
        {section('tasks', 'Tasks', (t) => (
          <ListRow key={t.id} left={<Icon name="task" size={18} color={c.ink2} />} title={t.title} subtitle={`${t.project?.name ?? 'Personal'} · ${t.owner?.name ?? 'Unassigned'}`} right={<StatusPill status={t.status} />} onPress={() => go(`/tasks/${t.id}`)} />
        ))}
        {section('decisions', 'Decisions', (d) => (
          <ListRow
            key={d.id}
            left={<Icon name="gavel" size={18} color={c.ink2} />}
            title={d.title}
            subtitle={`${d.decided_by_name} · ${d.project_name ?? 'Workspace'} · ${timeAgo(d.created_at)}`}
            onPress={() => go(d.project_id ? `/projects/${d.project_id}?tab=decisions` : '/decisions')}
          />
        ))}
        {section('files', 'Files', (f) => (
          <ListRow key={f.id} left={<Icon name={f.external_url ? 'link' : 'file'} size={18} color={c.ink2} />} title={f.name} subtitle={`${f.owner_name} · ${timeAgo(f.updated_at)}${f.snippet ? `\n…${f.snippet}…` : ''}`} onPress={() => go(`/files/${f.id}`)} />
        ))}
        {section('projects', 'Projects', (p) => (
          <ListRow
            key={p.id}
            left={
              <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: swatch(p.color), alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="folder" size={14} color="#fff" />
              </View>
            }
            title={p.name}
            subtitle={p.description?.slice(0, 100)}
            onPress={() => go(`/projects/${p.id}`)}
          />
        ))}
        {section('meetings', 'Meetings', (m) => (
          <ListRow key={m.id} left={<Icon name="video" size={18} color={c.ink2} />} title={m.title} subtitle={dateTime(m.starts_at)} onPress={() => go(`/meetings/${m.id}`)} />
        ))}
        {section('people', 'People', (p) => (
          <ListRow key={p.id} left={<Avatar user={p} size="sm" />} title={p.name} subtitle={[p.title, ...(p.expertise ?? [])].filter(Boolean).join(' · ')} onPress={() => go(`/people/${p.id}`)} />
        ))}
        {aiEnabled && q.trim().endsWith('?') && !ask && <Button small icon="spark" title="Ask Küü" onPress={runAsk} />}
      </Screen>
    </>
  );
}
