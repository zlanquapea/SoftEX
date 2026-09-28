import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type UserRef } from '../api';
import { Icon } from '../components/Icon';
import { Logo } from '../components/Logo';
import { useProjectFields } from '../components/Work';
import { Empty, ErrorState, Field, Loading, Modal, useAction, useToast } from '../components/ui';
import { useApi } from '../hooks';
import { useSession } from '../session';

type QuestionType = 'short' | 'long' | 'email' | 'number' | 'date' | 'select';
interface Question {
  id: string;
  label: string;
  type: QuestionType;
  required: boolean;
  options: string[];
  maps?: string | null;
}
interface Form {
  id: string;
  project_id: string;
  title: string;
  description: string;
  questions: Question[];
  public: boolean;
  public_url: string | null;
  owner: UserRef | null;
  closed: boolean;
  responses: number;
  created_at: string;
  project?: { id: string; name: string } | null;
  can_manage?: boolean;
}

const TYPE_LABEL: Record<QuestionType, string> = { short: 'Short answer', long: 'Paragraph', email: 'Email', number: 'Number', date: 'Date', select: 'Choice' };
const MAPS_LABEL: Record<string, string> = { title: 'Task title', description: 'Task description', due_date: 'Due date', priority: 'Priority' };

const newQuestion = (n: number, patch: Partial<Question> = {}): Question => ({
  id: `q${Date.now().toString(36)}${n}`,
  label: '',
  type: 'short',
  required: false,
  options: [],
  maps: null,
  ...patch,
});

/** A project's intake forms (Asana/Monday forms): requests from anyone become tasks. */
export function ProjectForms({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { data, error, reload } = useApi<Form[]>(`/projects/${projectId}/forms`);
  const [editing, setEditing] = useState<Form | 'new' | null>(null);
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading />;
  return (
    <div>
      <div className="toolbar">
        <p className="muted grow">Collect requests with a form. Every response becomes a task here, assigned to the form’s owner.</p>
        {canManage && (
          <button className="btn primary sm" onClick={() => setEditing('new')}>
            <Icon name="plus" size={15} /> New form
          </button>
        )}
      </div>
      {!data.length && <Empty icon="form" title="No forms yet">{canManage ? 'Create one to take in bug reports, design requests or IT tickets.' : 'Project leads can create forms.'}</Empty>}
      <div className="card-list">
        {data.map((f) => (
          <article key={f.id} className="card pad form-card">
            <div className="row-gap">
              <Icon name="form" size={18} />
              <strong className="grow">{f.title}</strong>
              {f.closed ? <span className="pill">Closed</span> : f.public ? <span className="pill status-done">Public link</span> : <span className="pill">Members only</span>}
            </div>
            <p className="muted small">
              {f.questions.length} question{f.questions.length === 1 ? '' : 's'} · {f.responses} response{f.responses === 1 ? '' : 's'}
              {f.owner && <> · goes to {f.owner.name}</>}
            </p>
            <div className="row-gap wrap">
              <Link className="btn sm" to={`/forms/${f.id}`}>
                Open form
              </Link>
              {f.public_url && <CopyLink url={f.public_url} />}
              {canManage && (
                <button className="btn sm" onClick={() => setEditing(f)}>
                  Edit
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {editing && (
        <FormBuilder
          projectId={projectId}
          form={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function CopyLink({ url }: { url: string }) {
  const toast = useToast();
  return (
    <button
      className="btn sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          toast('Link copied');
        } catch {
          prompt('Copy this link', url);
        }
      }}
    >
      <Icon name="link" size={14} /> Copy public link
    </button>
  );
}

function FormBuilder({ projectId, form, onClose, onSaved }: { projectId: string; form: Form | null; onClose: () => void; onSaved: () => void }) {
  const act = useAction();
  const { people } = useSession();
  const { data: fields } = useProjectFields(projectId);
  const [title, setTitle] = useState(form?.title ?? '');
  const [description, setDescription] = useState(form?.description ?? '');
  const [ownerId, setOwnerId] = useState(form?.owner?.id ?? '');
  const [isPublic, setPublic] = useState(form?.public ?? false);
  const [closed, setClosed] = useState(form?.closed ?? false);
  const [questions, setQuestions] = useState<Question[]>(
    form?.questions ?? [newQuestion(0, { label: 'What do you need?', required: true, maps: 'title' }), newQuestion(1, { label: 'Details', type: 'long', maps: 'description' })],
  );
  const set = (i: number, patch: Partial<Question>) => setQuestions((qs) => qs.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const mapOptions = [...Object.entries(MAPS_LABEL), ...(fields ?? []).map((f) => [f.id, `Field: ${f.name}`] as [string, string])];

  const save = async () => {
    const body = { title, description, ownerId: ownerId || null, public: isPublic, questions: questions.map((q) => ({ ...q, options: q.type === 'select' ? q.options : [] })) };
    const ok = form ? await act(() => api.patch(`/forms/${form.id}`, { ...body, closed }), 'Form saved') : await act(() => api.post(`/projects/${projectId}/forms`, body), 'Form created');
    if (ok) onSaved();
  };

  return (
    <Modal open onClose={onClose} title={form ? 'Edit form' : 'New form'} eyebrow="Intake form" wide>
      <div className="stack">
        <Field label="Title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Design request" />
        </Field>
        <Field label="Introduction" hint="Shown above the questions.">
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />
        </Field>
        <div className="grid-2">
          <Field label="New tasks go to">
            <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <option value="">Nobody (unassigned)</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="stack">
            <label className="check-inline">
              <input type="checkbox" checked={isPublic} onChange={(e) => setPublic(e.target.checked)} /> Anyone with the link can respond (no sign-in)
            </label>
            {form && (
              <label className="check-inline">
                <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} /> Closed — stop taking responses
              </label>
            )}
          </div>
        </div>
        <h3>Questions</h3>
        {questions.map((q, i) => (
          <div key={q.id} className="question-edit card pad">
            <div className="row-gap wrap">
              <input className="grow" value={q.label} onChange={(e) => set(i, { label: e.target.value })} placeholder={`Question ${i + 1}`} aria-label={`Question ${i + 1}`} maxLength={200} />
              <select value={q.type} onChange={(e) => set(i, { type: e.target.value as QuestionType })} aria-label="Answer type">
                {(Object.keys(TYPE_LABEL) as QuestionType[]).map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
              <button className="icon-btn xs" aria-label="Remove question" disabled={questions.length === 1} onClick={() => setQuestions((qs) => qs.filter((_, j) => j !== i))}>
                <Icon name="trash" size={13} />
              </button>
            </div>
            {q.type === 'select' && (
              <input
                value={q.options.join(', ')}
                onChange={(e) => set(i, { options: e.target.value.split(',').map((o) => o.trimStart()) })}
                onBlur={() => set(i, { options: q.options.map((o) => o.trim()).filter(Boolean) })}
                placeholder="Choices, separated by commas"
                aria-label="Choices"
              />
            )}
            <div className="row-gap wrap small">
              <label className="check-inline">
                <input type="checkbox" checked={q.required} onChange={(e) => set(i, { required: e.target.checked })} /> Required
              </label>
              <label className="check-inline">
                Fills in
                <select value={q.maps ?? ''} onChange={(e) => set(i, { maps: e.target.value || null })} aria-label="Fills in">
                  <option value="">Description only</option>
                  {mapOptions.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        ))}
        <button className="btn sm" onClick={() => setQuestions((qs) => [...qs, newQuestion(qs.length)])} disabled={questions.length >= 40}>
          <Icon name="plus" size={14} /> Add question
        </button>
        <div className="form-actions">
          {form && (
            <button
              className="btn danger-text"
              onClick={async () => {
                if (!confirm('Delete this form? Tasks it created stay.')) return;
                if (await act(() => api.del(`/forms/${form.id}`), 'Form deleted')) onSaved();
              }}
            >
              Delete
            </button>
          )}
          <span className="grow" />
          {form?.public && (
            <button
              className="btn"
              onClick={async () => {
                if (!confirm('Make a new public link? The old one stops working.')) return;
                if (await act(() => api.patch(`/forms/${form.id}`, { newLink: true }), 'New link created')) onSaved();
              }}
            >
              New link
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={!title.trim() || questions.some((q) => !q.label.trim())}>
            Save form
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The questions, as a fillable form. */
function FormFields({ questions, answers, onChange }: { questions: Question[]; answers: Record<string, unknown>; onChange: (a: Record<string, unknown>) => void }) {
  const set = (id: string, v: unknown) => onChange({ ...answers, [id]: v });
  return (
    <>
      {questions.map((q) => {
        const value = (answers[q.id] as string | undefined) ?? '';
        const label = `${q.label}${q.required ? ' *' : ''}`;
        return (
          <Field key={q.id} label={label}>
            {q.type === 'long' ? (
              <textarea rows={4} value={value} required={q.required} maxLength={10000} onChange={(e) => set(q.id, e.target.value)} />
            ) : q.type === 'select' ? (
              <select value={value} required={q.required} onChange={(e) => set(q.id, e.target.value)}>
                <option value="">Choose…</option>
                {q.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={q.type === 'short' ? 'text' : q.type}
                value={value}
                required={q.required}
                maxLength={q.type === 'short' ? 500 : undefined}
                onChange={(e) => set(q.id, q.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
              />
            )}
          </Field>
        );
      })}
    </>
  );
}

const cleanAnswers = (answers: Record<string, unknown>) => Object.fromEntries(Object.entries(answers).filter(([, v]) => v !== '' && v !== undefined));

/** Internal fill page for workspace members: /forms/:id */
export function FormFill() {
  const { id } = useParams();
  const act = useAction();
  const { data: form, error, reload } = useApi<Form>(`/forms/${id}`);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [done, setDone] = useState<string | null>(null);
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!form) return <Loading />;
  return (
    <div className="page narrow">
      <p className="eyebrow">{form.project ? <Link to={`/projects/${form.project.id}?tab=forms`}>{form.project.name}</Link> : 'Form'}</p>
      <h1>{form.title}</h1>
      {form.description && <p className="muted pre-wrap">{form.description}</p>}
      {done ? (
        <div className="card pad stack">
          <strong>Thanks — your request was sent.</strong>
          <div className="row-gap">
            <Link className="btn sm" to={`/tasks/${done}`}>
              View the task
            </Link>
            <button
              className="btn sm"
              onClick={() => {
                setAnswers({});
                setDone(null);
              }}
            >
              Send another
            </button>
          </div>
        </div>
      ) : form.closed ? (
        <Empty icon="lock" title="This form is closed" />
      ) : (
        <form
          className="card pad stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const res = await act(() => api.post<{ taskId: string }>(`/forms/${form.id}/responses`, { answers: cleanAnswers(answers) }));
            if (res) setDone(res.taskId);
          }}
        >
          <FormFields questions={form.questions} answers={answers} onChange={setAnswers} />
          <div className="form-actions">
            <button className="btn primary">Submit</button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Public fill page, no sign-in: /f/:token */
export function PublicForm() {
  const { token } = useParams();
  const { data: form, error } = useApi<{ title: string; description: string; workspace_name: string; questions: Question[]; closed: boolean }>(`/public/forms/${token}`);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [who, setWho] = useState({ name: '', email: '', website: '' });
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [problem, setProblem] = useState('');
  return (
    <div className="public-shell">
      <header className="public-head">
        <Logo height={24} />
      </header>
      <main className="public-main">
        {error ? (
          <Empty icon="alert" title="This form isn’t available">The link may have been changed or removed.</Empty>
        ) : !form ? (
          <Loading />
        ) : (
          <>
            <p className="eyebrow">{form.workspace_name}</p>
            <h1>{form.title}</h1>
            {form.description && <p className="muted pre-wrap">{form.description}</p>}
            {state === 'sent' ? (
              <div className="card pad">
                <strong>Thank you — your response was received.</strong>
              </div>
            ) : form.closed ? (
              <Empty icon="lock" title="This form is no longer taking responses" />
            ) : (
              <form
                className="card pad stack"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setState('sending');
                  setProblem('');
                  try {
                    await api.post(`/public/forms/${token}`, { answers: cleanAnswers(answers), ...who });
                    setState('sent');
                  } catch (err) {
                    setProblem((err as Error).message);
                    setState('idle');
                  }
                }}
              >
                <FormFields questions={form.questions} answers={answers} onChange={setAnswers} />
                <div className="grid-2">
                  <Field label="Your name">
                    <input value={who.name} onChange={(e) => setWho({ ...who, name: e.target.value })} maxLength={100} autoComplete="name" />
                  </Field>
                  <Field label="Your email" hint="So the team can follow up.">
                    <input type="email" value={who.email} onChange={(e) => setWho({ ...who, email: e.target.value })} maxLength={200} autoComplete="email" />
                  </Field>
                </div>
                {/* Left empty by people; bots fill it in. */}
                <input className="hp-field" tabIndex={-1} autoComplete="off" aria-hidden="true" value={who.website} onChange={(e) => setWho({ ...who, website: e.target.value })} name="website" />
                {problem && <p className="hint-box warn">{problem}</p>}
                <div className="form-actions">
                  <button className="btn primary" disabled={state === 'sending'}>
                    {state === 'sending' ? 'Sending…' : 'Submit'}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
        <p className="muted small public-foot">Powered by Küü</p>
      </main>
    </div>
  );
}
