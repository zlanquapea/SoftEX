import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../api';
import { dateTime, plainMentions, timeAgo } from '../format';
import { useDebounced } from '../hooks';
import { useSession } from '../session';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { StatusPill } from './ui';

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

  useEffect(() => {
    const d = ref.current!;
    if (open) {
      setQ(initial);
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
              placeholder="Search messages, tasks, files, knowledge and people…"
              aria-label="Search"
              onKeyDown={(e) => {
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
