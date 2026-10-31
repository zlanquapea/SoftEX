import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs, type Channel, type Me } from '../api';
import { dateTime, plainMentions, timeAgo } from '../format';
import { useApi, useDebounced } from '../hooks';
import { useRecentPlaces } from '../recent';
import { effectiveTheme, getTheme, setTheme } from '../theme';
import { useShell } from './Layout';
import { GO_TO } from './Shortcuts';
import { usePeople, useSession } from '../session';
import { useAiEnabled } from './Ai';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { Pill, StatusPill } from '@/components/kit';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Command, CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

interface AskResult {
  question: string;
  answer: string;
  sources: { n: number; type: string; title: string; link: string; snippet: string; date: string | null }[];
}

/** Sources the answer cites, or all of them when it cites none. */
function citedSources(a: AskResult) {
  const cited = new Set([...a.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  return cited.size ? a.sources.filter((s) => cited.has(s.n)) : a.sources;
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

/** In "All", each group shows this many results before "Show more". */
const FOLD_AT = 4;
/** How many results per group "All" fetches, so a group can be opened up without searching again. */
const ALL_LIMIT = 20;

function ResultItem({ value, onSelect, media, title, meta, snippet, end }: { value: string; onSelect: () => void; media: ReactNode; title: ReactNode; meta?: ReactNode; snippet?: ReactNode; end?: ReactNode }) {
  return (
    <CommandItem value={value} onSelect={onSelect} className="items-start gap-3 py-2">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center text-muted-foreground">{media}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 truncate font-medium">{title}</span>
        {meta && <span className="truncate text-xs text-muted-foreground">{meta}</span>}
        {snippet && <span className="line-clamp-2 text-xs text-muted-foreground">{snippet}</span>}
      </span>
      {end}
    </CommandItem>
  );
}

const PLACE_ICON: Record<string, string> = { channel: 'hash', project: 'folder', task: 'task', page: 'book', file: 'file', meeting: 'video', person: 'users', team: 'users', goal: 'target', board: 'whiteboard', dashboard: 'chart' };

interface Command {
  id: string;
  label: string;
  icon: string;
  hint?: string;
  /** Extra words it can be found by. */
  words?: string;
  run: () => void | Promise<unknown>;
}

/** Date ranges for message search, in days back from today. */
const WHEN = [
  { value: '', label: 'Any time' },
  { value: '1', label: 'Today' },
  { value: '7', label: 'Past week' },
  { value: '30', label: 'Past month' },
  { value: '365', label: 'Past year' },
];
const PAGE = 25;

export function SearchDialog({ open, initial, initialChannel, onClose }: { open: boolean; initial: string; initialChannel?: string; onClose: () => void }) {
  const navigate = useNavigate();
  const people = usePeople();
  const { me, setMe } = useSession();
  const { openCreate } = useShell();
  const recent = useRecentPlaces();
  // Places to jump to by name; loaded when the palette opens.
  const { data: channels } = useApi<Channel[]>(open ? '/channels' : null);
  const { data: projects } = useApi<{ id: string; name: string; color: string }[]>(open ? '/projects' : null);
  const { data: teams } = useApi<{ id: string; name: string }[]>(open ? '/teams' : null);
  const [q, setQ] = useState(initial);
  const [type, setType] = useState<SearchType>('all');
  const [from, setFrom] = useState('');
  const [hasFile, setHasFile] = useState(false);
  const [channelId, setChannelId] = useState('');
  const [when, setWhen] = useState('');
  const [moreMessages, setMoreMessages] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [results, setResults] = useState<Record<string, any[]> | null>(null);
  // Groups the person opened up to see past the first few results.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const debounced = useDebounced(q, 200);
  const aiEnabled = useAiEnabled();
  const [ask, setAsk] = useState<AskResult | { question: string; loading: true } | { question: string; error: string } | null>(null);

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

  useEffect(() => {
    if (open) {
      setQ(initial);
      setAsk(null);
      setChannelId(initialChannel ?? '');
      if (initialChannel) setType('messages');
    }
  }, [open, initial, initialChannel]);
  const after = when ? new Date(Date.now() - (Number(when) - 1) * 86_400_000).toISOString().slice(0, 10) : undefined;
  const messageQuery = (offset: number) =>
    `/search${qs({ q: debounced.trim(), type, from, hasFile: hasFile ? 'true' : undefined, channelId: channelId || undefined, after, limit: type === 'all' ? ALL_LIMIT : PAGE, offset })}`;
  const loadMoreMessages = async () => {
    setLoadingMore(true);
    const r = await api.get(messageQuery(results?.messages?.length ?? 0)).catch(() => null);
    setLoadingMore(false);
    if (!r) return;
    setResults((prev) => ({ ...(prev ?? {}), messages: [...(prev?.messages ?? []), ...r.messages] }));
    setMoreMessages(!!r.messages_has_more);
  };

  useEffect(() => {
    if (!open) return;
    if (debounced.trim().length < 2 && !from && !hasFile && !channelId) {
      setResults(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .get(messageQuery(0))
      .then((r) => {
        if (cancelled) return;
        setMoreMessages(!!r.messages_has_more);
        delete r.messages_has_more;
        setResults(r);
        setExpanded(new Set());
      })
      .catch(() => !cancelled && setResults(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, type, from, hasFile, channelId, when, open]);

  const go = (path: string) => {
    onClose();
    navigate(path);
  };
  const focusFor = async (minutes: number) => {
    onClose();
    const updated = await api.patch<Me>('/me', { status: 'focus', focus_until: new Date(Date.now() + minutes * 60_000).toISOString() }).catch(() => null);
    if (updated) setMe(updated);
  };
  const dark = effectiveTheme(getTheme()) === 'dark';
  const commands: Command[] = [
    { id: 'new-task', label: 'Create a task', icon: 'task', hint: 'C', words: 'new add todo', run: () => (onClose(), openCreate('task')) },
    {
      id: 'new-page',
      label: 'Write a new page',
      icon: 'book',
      words: 'new knowledge note doc',
      run: async () => {
        onClose();
        const page = await api.post<{ id: string }>('/pages', {}).catch(() => null);
        if (page) navigate(`/knowledge/${page.id}?edit=1&new=1`);
      },
    },
    { id: 'new-meeting', label: 'Schedule a meeting', icon: 'video', words: 'new call event calendar', run: () => (onClose(), openCreate('meeting')) },
    { id: 'new-message', label: 'Send a message', icon: 'chat', words: 'new dm chat write', run: () => (onClose(), openCreate('message')) },
    ...(me?.role !== 'guest' ? [{ id: 'new-project', label: 'Start a project', icon: 'folder', words: 'new', run: () => (onClose(), openCreate('project')) }] : []),
    { id: 'focus-30', label: 'Focus for 30 minutes', icon: 'clock', words: 'do not disturb dnd quiet', run: () => focusFor(30) },
    { id: 'focus-60', label: 'Focus for 1 hour', icon: 'clock', words: 'do not disturb dnd quiet', run: () => focusFor(60) },
    { id: 'theme', label: dark ? 'Switch to light mode' : 'Switch to dark mode', icon: dark ? 'sun' : 'moon', words: 'theme appearance', run: () => setTheme(dark ? 'light' : 'dark') },
    { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'help', hint: '?', words: 'keys help', run: () => (onClose(), window.dispatchEvent(new Event('kuu:shortcuts'))) },
    ...GO_TO.map((g) => ({ id: `go-${g.path}`, label: `Go to ${g.label}`, icon: 'arrow', hint: `G ${g.key.toUpperCase()}`, run: () => go(g.path) })),
  ];
  const needle = q.trim().toLowerCase();
  const matches = (text: string) => text.toLowerCase().includes(needle);
  const matchedCommands = needle ? commands.filter((c) => matches(`${c.label} ${c.words ?? ''}`)).slice(0, 5) : commands.slice(0, 6);
  // Places whose name matches what's typed: chats, channels, people, projects and teams.
  const jumps = needle
    ? [
        ...(channels ?? []).filter((c) => c.kind !== 'dm' && matches(c.name)).map((c) => ({ key: `c-${c.id}`, label: `#${c.name}`, icon: c.kind === 'private' ? 'lock' : 'hash', path: `/channels/${c.id}`, person: null })),
        ...people.filter((p) => matches(p.name)).map((p) => ({ key: `p-${p.id}`, label: p.name, icon: 'users', path: `/people/${p.id}`, person: p })),
        ...(projects ?? []).filter((p) => matches(p.name)).map((p) => ({ key: `pr-${p.id}`, label: p.name, icon: 'folder', path: `/projects/${p.id}`, person: null })),
        ...(teams ?? []).filter((t) => matches(t.name)).map((t) => ({ key: `t-${t.id}`, label: `${t.name} team`, icon: 'users', path: `/teams/${t.id}`, person: null })),
      ].slice(0, 6)
    : [];

  const total = results ? Object.values(results).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0) : 0;
  const conversationLabel = (c: Channel) =>
    c.personal ? 'Saved' : c.kind === 'dm' ? c.members?.map((m) => m.name).join(', ') || 'Direct message' : `#${c.name}`;
  // In "All", a group with more than a few results shows the first few and can be opened up.
  const section = (key: string, title: string, render: (item: any) => ReactNode) => {
    const list = results?.[key] ?? [];
    if (!list.length) return null;
    const folded = type === 'all' && list.length > FOLD_AT && !expanded.has(key);
    const more = list.length - FOLD_AT;
    return (
      <CommandGroup heading={`${title} · ${list.length}${type === 'all' && list.length >= ALL_LIMIT ? '+' : ''}`} key={key}>
        {(folded ? list.slice(0, FOLD_AT) : list).map(render)}
        {folded && (
          <CommandItem value={`more-${key}`} onSelect={() => setExpanded(new Set(expanded).add(key))} className="justify-center py-1.5 text-xs font-medium text-primary">
            <Icon name="chevronDown" size={14} /> Show {more}
            {list.length >= ALL_LIMIT ? '+' : ''} more {title.toLowerCase()}
          </CommandItem>
        )}
      </CommandGroup>
    );
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Search"
      description="Search messages, tasks, files, knowledge and people"
      className="top-[12dvh] w-[calc(100%-1.5rem)] sm:max-w-2xl"
    >
      <Command
        shouldFilter={false}
        className="rounded-none"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && aiEnabled && (e.shiftKey || q.trim().endsWith('?'))) {
            e.preventDefault();
            runAsk();
          }
        }}
      >
        <CommandInput
          value={q}
          onValueChange={setQ}
          autoFocus
          placeholder={aiEnabled ? 'Search, or ask a question ending with “?”' : 'Search messages, tasks, files, knowledge and people…'}
          aria-label="Search"
        />
        <div className="flex flex-wrap items-center gap-2 border-b px-2 py-2">
          <ToggleGroup
            value={[type]}
            onValueChange={(v) => v[0] && setType(v[0] as SearchType)}
            variant="outline"
            size="sm"
            spacing={1}
            className="flex-wrap"
            aria-label="Search in"
          >
            {TYPES.map((t) => (
              <ToggleGroupItem key={t.id} value={t.id} className="h-6 rounded-full px-2.5 text-xs">
                {t.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {(type === 'messages' || type === 'all' || type === 'tasks') && (
            <NativeSelect size="sm" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From person">
              <NativeSelectOption value="">Anyone</NativeSelectOption>
              {people.map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>
                  {p.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
          {(type === 'messages' || type === 'all') && (
            <>
              <NativeSelect size="sm" value={channelId} onChange={(e) => setChannelId(e.target.value)} aria-label="In conversation" className="max-w-44">
                <NativeSelectOption value="">All conversations</NativeSelectOption>
                {(channels ?? [])
                  .filter((c) => c.personal || c.kind === 'dm' || c.joined)
                  .sort((a, b) => Number(!!b.personal) - Number(!!a.personal) || conversationLabel(a).localeCompare(conversationLabel(b)))
                  .map((c) => (
                    <NativeSelectOption key={c.id} value={c.id}>
                      {conversationLabel(c)}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
              <NativeSelect size="sm" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="When">
                {WHEN.map((w) => (
                  <NativeSelectOption key={w.value} value={w.value}>
                    {w.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Label className="text-xs font-normal">
                <Checkbox checked={hasFile} onCheckedChange={(v) => setHasFile(!!v)} /> Has attachment
              </Label>
            </>
          )}
          {loading && <Spinner className="ml-auto text-muted-foreground" aria-label="Searching" />}
        </div>
        {ask && (
          <section className="flex max-h-72 flex-col gap-2 overflow-y-auto border-b bg-accent/40 px-4 py-3 text-sm" aria-live="polite">
            <header className="flex items-center gap-2 font-medium">
              <Icon name="spark" size={14} className="text-primary" /> {ask.question}
            </header>
            {'loading' in ask && (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Spinner /> <span className="shimmer">Reading what you have access to…</span>
              </p>
            )}
            {'error' in ask && <p className="text-destructive">{ask.error}</p>}
            {'answer' in ask && (
              <>
                {ask.answer.split(/\n{2,}/).map((para, i) => (
                  <p key={i}>
                    {para.split(/(\[\d+\])/g).map((part, j) => {
                      const m = part.match(/^\[(\d+)\]$/);
                      const src = m ? ask.sources.find((s) => s.n === Number(m[1])) : undefined;
                      return src ? (
                        <Badge key={j} variant="brand" className="mx-0.5 cursor-pointer align-super" render={<button type="button" onClick={() => go(src.link)} title={src.title} />}>
                          {src.n}
                        </Badge>
                      ) : (
                        <span key={j}>{part}</span>
                      );
                    })}
                  </p>
                ))}
                {ask.sources.length > 0 && (
                  <ol className="flex flex-col gap-1">
                    {citedSources(ask).map((s) => (
                      <li key={s.n} className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="brand">{s.n}</Badge>
                        <Button variant="link" size="inline" onClick={() => go(s.link)}>
                          <Icon name={SOURCE_ICON[s.type] ?? 'file'} /> {s.title}
                        </Button>
                        {s.date && <span className="text-xs text-muted-foreground">· {timeAgo(s.date)}</span>}
                      </li>
                    ))}
                  </ol>
                )}
                <p className="text-xs text-muted-foreground">AI answer — check the sources before relying on it. Only you can see this.</p>
              </>
            )}
          </section>
        )}
        <CommandList className="max-h-[min(60dvh,28rem)] px-1 pb-1">
          {aiEnabled && q.trim().length >= 3 && (!ask || ask.question !== q.trim()) && (
            <CommandGroup>
              <ResultItem
                value="ask"
                onSelect={runAsk}
                media={<Icon name="spark" className="text-primary" />}
                title={`Ask Küü: “${q.trim()}”`}
                meta="Get an answer with sources from messages, knowledge, decisions and files you can access. Shift+Enter"
              />
            </CommandGroup>
          )}
          {!needle && recent.length > 0 && (
            <CommandGroup heading="Recent">
              {recent.slice(0, 5).map((r) => (
                <ResultItem key={r.path} value={`recent-${r.path}`} onSelect={() => go(r.path)} media={<Icon name={PLACE_ICON[r.kind] ?? 'arrow'} />} title={r.label} meta={timeAgo(new Date(r.at).toISOString())} />
              ))}
            </CommandGroup>
          )}
          {jumps.length > 0 && (
            <CommandGroup heading="Go to">
              {jumps.map((j) => (
                <ResultItem
                  key={j.key}
                  value={`jump-${j.key}`}
                  onSelect={() => go(j.path)}
                  media={j.person ? <Avatar user={j.person} size="sm" /> : <Icon name={j.icon} />}
                  title={j.label}
                />
              ))}
            </CommandGroup>
          )}
          {matchedCommands.length > 0 && (
            <CommandGroup heading="Commands">
              {matchedCommands.map((c) => (
                <ResultItem
                  key={c.id}
                  value={`cmd-${c.id}`}
                  onSelect={() => void c.run()}
                  media={<Icon name={c.icon} />}
                  title={c.label}
                  end={c.hint ? <kbd className="rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">{c.hint}</kbd> : undefined}
                />
              ))}
            </CommandGroup>
          )}
          {!results && needle.length < 2 && <p className="px-3 py-4 text-center text-xs text-muted-foreground">Type to search messages, tasks, files, knowledge and people — only what you have access to.</p>}
          {results && total === 0 && !loading && !jumps.length && !matchedCommands.length && <p className="px-3 py-6 text-center text-sm text-muted-foreground">No results for “{debounced}”.</p>}
          {section('pages', 'Knowledge', (p) => (
            <ResultItem
              key={p.id}
              value={`page-${p.id}`}
              onSelect={() => go(`/knowledge/${p.id}`)}
              media={<Icon name="book" />}
              title={
                <>
                  <span className="truncate">{p.title}</span>
                  {p.status === 'approved' && <Pill tone="success">Approved</Pill>}
                </>
              }
              meta={`${p.owner_name} · ${p.review_date ? `review ${p.review_date}` : `updated ${timeAgo(p.updated_at)}`}`}
              snippet={p.snippet && `…${p.snippet.replace(/[#*_>`]/g, '').replace(/\s+/g, ' ')}…`}
            />
          ))}
          {section('messages', 'Messages', (m) => (
            <ResultItem
              key={m.id}
              value={`message-${m.id}`}
              onSelect={() => go(`/channels/${m.channel_id}?message=${m.parent_id ?? m.id}`)}
              media={<Avatar user={{ name: m.user_name, color: m.user_color }} size="sm" />}
              title={
                <>
                  {m.user_name}{' '}
                  <span className="text-xs font-normal text-muted-foreground">
                    in {m.saved ? 'Saved' : m.channel_kind === 'dm' ? 'a direct message' : `#${m.channel_name}`}
                    {m.parent_id ? ' · thread' : ''}
                  </span>
                </>
              }
              snippet={
                <>
                  {m.forwarded && <span className="font-medium">Forwarded from {m.forwarded.user_name}: </span>}
                  {m.snippet ?? plainMentions(m.body).slice(0, 180)}
                </>
              }
              meta={dateTime(m.created_at)}
            />
          ))}
          {type === 'messages' && moreMessages && (
            <CommandGroup>
              <CommandItem value="more-messages" onSelect={loadMoreMessages} className="justify-center py-2 text-xs font-medium text-primary" disabled={loadingMore}>
                {loadingMore ? <Spinner /> : <Icon name="chevronDown" size={14} />} Load more messages
              </CommandItem>
            </CommandGroup>
          )}
          {section('tasks', 'Tasks', (t) => (
            <ResultItem
              key={t.id}
              value={`task-${t.id}`}
              onSelect={() => go(`/tasks/${t.id}`)}
              media={<Icon name="task" />}
              title={t.title}
              meta={`${t.project?.name ?? 'Personal'} · ${t.owner?.name ?? 'Unassigned'}`}
              end={<StatusPill status={t.status} />}
            />
          ))}
          {section('decisions', 'Decisions', (d) => (
            <ResultItem
              key={d.id}
              value={`decision-${d.id}`}
              onSelect={() => go(d.project_id ? `/projects/${d.project_id}?tab=decisions` : '/decisions')}
              media={<Icon name="gavel" />}
              title={d.title}
              meta={`${d.decided_by_name} · ${d.project_name ?? 'Workspace'} · ${timeAgo(d.created_at)}`}
            />
          ))}
          {section('files', 'Files', (f) => (
            <ResultItem
              key={f.id}
              value={`file-${f.id}`}
              onSelect={() => go(`/files/${f.id}`)}
              media={<Icon name={f.external_url ? 'link' : 'file'} />}
              title={f.name}
              meta={`${f.owner_name} · ${timeAgo(f.updated_at)}`}
              snippet={f.snippet && `…${f.snippet}…`}
            />
          ))}
          {section('projects', 'Projects', (p) => (
            <ResultItem
              key={p.id}
              value={`project-${p.id}`}
              onSelect={() => go(`/projects/${p.id}`)}
              media={
                <span className="flex size-6 items-center justify-center rounded-md text-white" style={{ background: `var(--c-${p.color})` }}>
                  <Icon name="folder" size={14} />
                </span>
              }
              title={p.name}
              meta={p.description?.slice(0, 100)}
            />
          ))}
          {section('meetings', 'Meetings', (m) => (
            <ResultItem key={m.id} value={`meeting-${m.id}`} onSelect={() => go(`/meetings/${m.id}`)} media={<Icon name="video" />} title={m.title} meta={dateTime(m.starts_at)} />
          ))}
          {section('people', 'People', (p) => (
            <ResultItem
              key={p.id}
              value={`person-${p.id}`}
              onSelect={() => go(`/people/${p.id}`)}
              media={<Avatar user={p} size="sm" />}
              title={p.name}
              meta={[p.title, ...(p.expertise ?? [])].filter(Boolean).join(' · ')}
            />
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
