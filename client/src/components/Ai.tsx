import { useState } from 'react';
import { api } from '../api';
import { useSession } from '../session';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { useAction } from './ui';

/** True when AI assistance is available and switched on for this workspace. */
export function useAiEnabled() {
  const { me } = useSession();
  return !!me?.workspace.ai_enabled && !!me?.workspace.ai_available && !!me?.workspace.plan?.features.includes('ai');
}

export function AiDraft({ text, onUse, useLabel }: { text: string; onUse?: () => void; useLabel?: string }) {
  return (
    <div className="ai-box" role="region" aria-label="AI draft">
      <header>
        <Icon name="spark" size={14} /> AI draft — check it before relying on it
      </header>
      <Markdown text={text} />
      <footer className="row-gap wrap">
        <span className="grow">Only visible to you. Generated from content you have access to.</span>
        <button className="btn sm" onClick={() => navigator.clipboard?.writeText(text)}>
          Copy
        </button>
        {onUse && (
          <button className="btn sm primary" onClick={onUse}>
            {useLabel ?? 'Use'}
          </button>
        )}
      </footer>
    </div>
  );
}

interface Suggestion {
  title: string;
  owner_id: string | null;
  owner_name: string | null;
  due_date: string | null;
  reason: string;
}

/** Thread tools: summary and task suggestions that a person reviews before anything is created. */
export function ThreadAi({ messageId, excluded }: { messageId: string; excluded: boolean }) {
  const enabled = useAiEnabled();
  const { people } = useSession();
  const act = useAction();
  const [busy, setBusy] = useState<'summary' | 'tasks' | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<{ project_id: string | null; source_message_id: string; suggestions: (Suggestion & { pick: boolean })[] } | null>(null);
  if (!enabled) return null;
  if (excluded) return <p className="muted small pad">AI assistance is turned off for this conversation.</p>;
  return (
    <div className="thread-ai">
      <div className="row-gap wrap">
        <button
          className="btn sm"
          disabled={!!busy}
          onClick={async () => {
            setBusy('summary');
            const res = await act(() => api.post<{ summary: string }>(`/ai/threads/${messageId}/summary`));
            setBusy(null);
            if (res) setSummary(res.summary);
          }}
        >
          <Icon name="spark" size={14} /> {busy === 'summary' ? 'Summarizing…' : 'Summarize thread'}
        </button>
        <button
          className="btn sm"
          disabled={!!busy}
          onClick={async () => {
            setBusy('tasks');
            const res = await act(() => api.post<{ project_id: string | null; source_message_id: string; suggestions: Suggestion[] }>(`/ai/threads/${messageId}/suggest-tasks`));
            setBusy(null);
            if (res) setSuggested({ ...res, suggestions: res.suggestions.map((s) => ({ ...s, pick: true })) });
          }}
        >
          <Icon name="task" size={14} /> {busy === 'tasks' ? 'Looking…' : 'Suggest tasks'}
        </button>
      </div>
      {summary && <AiDraft text={summary} />}
      {suggested && (
        <div className="ai-box">
          <header>
            <Icon name="spark" size={14} /> Suggested tasks — review before creating
          </header>
          {!suggested.suggestions.length && <p className="muted">No clear follow-ups found.</p>}
          {suggested.suggestions.map((s, i) => (
            <div key={i} className="suggestion">
              <input
                type="checkbox"
                checked={s.pick}
                aria-label={`Create ${s.title}`}
                onChange={(e) => setSuggested({ ...suggested, suggestions: suggested.suggestions.map((x, j) => (j === i ? { ...x, pick: e.target.checked } : x)) })}
              />
              <div className="grow">
                <input
                  value={s.title}
                  aria-label="Task title"
                  onChange={(e) => setSuggested({ ...suggested, suggestions: suggested.suggestions.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })}
                />
                <div className="row-gap wrap">
                  <select
                    value={s.owner_id ?? ''}
                    aria-label="Owner"
                    onChange={(e) => setSuggested({ ...suggested, suggestions: suggested.suggestions.map((x, j) => (j === i ? { ...x, owner_id: e.target.value || null } : x)) })}
                  >
                    <option value="">Unassigned</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="date"
                    value={s.due_date ?? ''}
                    aria-label="Due date"
                    onChange={(e) => setSuggested({ ...suggested, suggestions: suggested.suggestions.map((x, j) => (j === i ? { ...x, due_date: e.target.value || null } : x)) })}
                  />
                </div>
                <small className="muted">{s.reason}</small>
              </div>
            </div>
          ))}
          <footer className="row-gap">
            <span className="grow" />
            <button className="btn sm" onClick={() => setSuggested(null)}>
              Dismiss
            </button>
            <button
              className="btn sm primary"
              disabled={!suggested.suggestions.some((s) => s.pick)}
              onClick={async () => {
                let created = 0;
                for (const s of suggested.suggestions.filter((x) => x.pick)) {
                  const ok = await act(() =>
                    api.post('/tasks', { title: s.title, ownerId: s.owner_id, dueDate: s.due_date, projectId: suggested.project_id, sourceMessageId: suggested.source_message_id }),
                  );
                  if (ok) created += 1;
                }
                if (created) {
                  setSuggested(null);
                  await act(async () => undefined, `${created} task${created > 1 ? 's' : ''} created`);
                }
              }}
            >
              Create selected
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
