import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../api';
import { dateTime, plainMentions, timeAgo } from '../format';
import { useDebounced } from '../hooks';
import { useSession } from '../session';
import { useAiEnabled } from './Ai';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { StatusPill } from './ui';

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

export function SearchDialog({ open, initial, onClose }: { open: boolean; initial: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { people } = useSession();
  const [q, setQ] = useState(initial);
  const [type, setType] = useState<SearchType>('all');
  const [from, setFrom] = useState('');
  const [hasFile, setHasFile] = useState(false);
  const [results, setResults] = useState<Record<string, any[]> | null>(null);
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
    const d = ref.current!;
    if (open) {
      setQ(initial);
      setAsk(null);
      if (!d.open) d.showModal();
      window.setTimeout(() => input.current?.focus(), 10);
    } else if (d.open) d.close();
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
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
  }, [debounced, type, from, hasFile, open]);

  const go = (path: string) => {
    onClose();
    navigate(path);
  };

  const total = results ? Object.values(results).reduce((n, list) => n + list.length, 0) : 0;
  const section = (key: string, title: string, render: (item: any) => React.ReactNode) =>
    results && results[key]?.length ? (
      <section className="search-section" key={key}>
        <h3>{title}</h3>
        {results[key].map(render)}
      </section>
    ) : null;

  return (
    <dialog ref={ref} className="search-dialog" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-label="Search">
      {open && (
        <div className="search-panel">
          <div className="search-input">
            <Icon name="search" />
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={aiEnabled ? 'Search, or ask a question ending with “?”' : 'Search messages, tasks, files, knowledge and people…'}
              aria-label="Search"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && aiEnabled && (e.shiftKey || q.trim().endsWith('?'))) {
                  e.preventDefault();
                  runAsk();
                  return;
                }
                if (e.key === 'Enter') {
                  const first = ref.current?.querySelector<HTMLButtonElement>('.search-result');
                  first?.click();
                }
              }}
            />
            {loading && <span className="spinner sm" aria-hidden="true" />}
            <kbd>Esc</kbd>
          </div>
          <div className="search-filters">
            {TYPES.map((t) => (
              <button key={t.id} className={`chip-btn ${type === t.id ? 'active' : ''}`} onClick={() => setType(t.id)}>
                {t.label}
              </button>
            ))}
            {(type === 'messages' || type === 'all' || type === 'tasks') && (
              <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From person">
                <option value="">Anyone</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            {(type === 'messages' || type === 'all') && (
              <label className="check-inline">
                <input type="checkbox" checked={hasFile} onChange={(e) => setHasFile(e.target.checked)} /> Has attachment
              </label>
            )}
          </div>
          <div className="search-results">
            {aiEnabled && q.trim().length >= 3 && (!ask || ask.question !== q.trim()) && (
              <button className="search-result ask-row" onClick={runAsk}>
                <Icon name="spark" />
                <span>
                  <strong>Ask Küü: “{q.trim()}”</strong>
                  <small>Get an answer with sources from messages, knowledge, decisions and files you can access. Shift+Enter</small>
                </span>
              </button>
            )}
            {ask && (
              <section className="ask-answer" aria-live="polite">
                <header>
                  <Icon name="spark" size={14} /> {ask.question}
                </header>
                {'loading' in ask && (
                  <p className="muted">
                    <span className="spinner sm" aria-hidden="true" /> Reading what you have access to…
                  </p>
                )}
                {'error' in ask && <p className="danger-text">{ask.error}</p>}
                {'answer' in ask && (
                  <>
                    {ask.answer.split(/\n{2,}/).map((para, i) => (
                      <p key={i}>
                        {para.split(/(\[\d+\])/g).map((part, j) => {
                          const m = part.match(/^\[(\d+)\]$/);
                          const src = m ? ask.sources.find((s) => s.n === Number(m[1])) : undefined;
                          return src ? (
                            <button key={j} className="cite" onClick={() => go(src.link)} title={src.title}>
                              {src.n}
                            </button>
                          ) : (
                            <span key={j}>{part}</span>
                          );
                        })}
                      </p>
                    ))}
                    {ask.sources.length > 0 && (
                      <ol className="ask-sources">
                        {citedSources(ask).map((s) => (
                          <li key={s.n}>
                            <button className="link-btn" onClick={() => go(s.link)}>
                              <span className="cite">{s.n}</span> <Icon name={SOURCE_ICON[s.type] ?? 'file'} size={13} /> {s.title}
                            </button>
                            {s.date && <small className="muted"> · {timeAgo(s.date)}</small>}
                          </li>
                        ))}
                      </ol>
                    )}
                    <small className="muted">AI answer — check the sources before relying on it. Only you can see this.</small>
                  </>
                )}
              </section>
            )}
            {!results && <p className="muted pad">Type at least two characters. Results only include items you have access to.</p>}
            {results && total === 0 && !loading && <p className="muted pad">No results for “{debounced}”.</p>}
            {section('pages', 'Knowledge', (p) => (
              <button className="search-result" key={p.id} onClick={() => go(`/knowledge/${p.id}`)}>
                <Icon name="book" />
                <span>
                  <strong>
                    {p.title}
                    {p.status === 'approved' && <span className="pill status-done">Approved</span>}
                  </strong>
                  <small>
                    {p.owner_name} · {p.review_date ? `review ${p.review_date}` : `updated ${timeAgo(p.updated_at)}`}
                  </small>
                  {p.snippet && <small className="snippet">…{p.snippet.replace(/[#*_>`]/g, '').replace(/\s+/g, ' ')}…</small>}
                </span>
              </button>
            ))}
            {section('messages', 'Messages', (m) => (
              <button className="search-result" key={m.id} onClick={() => go(`/channels/${m.channel_id}?message=${m.parent_id ?? m.id}`)}>
                <Avatar user={{ name: m.user_name, color: m.user_color }} size="sm" />
                <span>
                  <strong>
                    {m.user_name} <small className="muted">in {m.channel_kind === 'dm' ? 'direct message' : `#${m.channel_name}`}</small>
                  </strong>
                  <small className="snippet">{plainMentions(m.body).slice(0, 180)}</small>
                  <small>{timeAgo(m.created_at)}</small>
                </span>
              </button>
            ))}
            {section('tasks', 'Tasks', (t) => (
              <button className="search-result" key={t.id} onClick={() => go(`/tasks/${t.id}`)}>
                <Icon name="task" />
                <span>
                  <strong>{t.title}</strong>
                  <small>
                    {t.project?.name ?? 'Personal'} · {t.owner?.name ?? 'Unassigned'}
                  </small>
                </span>
                <StatusPill status={t.status} />
              </button>
            ))}
            {section('decisions', 'Decisions', (d) => (
              <button className="search-result" key={d.id} onClick={() => go(d.project_id ? `/projects/${d.project_id}?tab=decisions` : '/decisions')}>
                <Icon name="gavel" />
                <span>
                  <strong>{d.title}</strong>
                  <small>
                    {d.decided_by_name} · {d.project_name ?? 'Workspace'} · {timeAgo(d.created_at)}
                  </small>
                </span>
              </button>
            ))}
            {section('files', 'Files', (f) => (
              <button className="search-result" key={f.id} onClick={() => go(`/files/${f.id}`)}>
                <Icon name={f.external_url ? 'link' : 'file'} />
                <span>
                  <strong>{f.name}</strong>
                  <small>
                    {f.owner_name} · {timeAgo(f.updated_at)}
                  </small>
                  {f.snippet && <small className="snippet">…{f.snippet}…</small>}
                </span>
              </button>
            ))}
            {section('projects', 'Projects', (p) => (
              <button className="search-result" key={p.id} onClick={() => go(`/projects/${p.id}`)}>
                <span className={`project-icon sm bg-${p.color}`}>
                  <Icon name="folder" size={14} />
                </span>
                <span>
                  <strong>{p.name}</strong>
                  <small>{p.description?.slice(0, 100)}</small>
                </span>
              </button>
            ))}
            {section('meetings', 'Meetings', (m) => (
              <button className="search-result" key={m.id} onClick={() => go(`/meetings/${m.id}`)}>
                <Icon name="video" />
                <span>
                  <strong>{m.title}</strong>
                  <small>{dateTime(m.starts_at)}</small>
                </span>
              </button>
            ))}
            {section('people', 'People', (p) => (
              <button className="search-result" key={p.id} onClick={() => go(`/people/${p.id}`)}>
                <Avatar user={p} size="sm" />
                <span>
                  <strong>{p.name}</strong>
                  <small>{[p.title, ...(p.expertise ?? [])].filter(Boolean).join(' · ')}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </dialog>
  );
}
