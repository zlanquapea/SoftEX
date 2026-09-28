import { useEffect, useState } from 'react';
import { api, LABEL_COLORS, type CustomField, type FieldType, type Label, type LabelColor, type TimeEntry } from '../api';
import { duration, localToday, timeAgo } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';
import { Icon } from './Icon';
import { UpgradeNotice, usePlan } from './Plan';
import { Modal, useAction } from './ui';

// ---------- Labels ----------

export function LabelChip({ label, onRemove }: { label: Pick<Label, 'name' | 'color'>; onRemove?: () => void }) {
  return (
    <span className={`label-chip lc-${label.color}`}>
      {label.name}
      {onRemove && (
        <button type="button" aria-label={`Remove label ${label.name}`} onClick={onRemove}>
          <Icon name="x" size={11} />
        </button>
      )}
    </span>
  );
}

export function LabelChips({ labels }: { labels?: Label[] }) {
  if (!labels?.length) return null;
  return (
    <span className="label-chips">
      {labels.map((l) => (
        <LabelChip key={l.id} label={l} />
      ))}
    </span>
  );
}

/** Pick labels for a task, creating new ones inline. */
export function LabelPicker({ taskId, value, disabled, onChange }: { taskId: string; value: Label[]; disabled?: boolean; onChange: (labels: Label[]) => void }) {
  const act = useAction();
  const { data: all, reload } = useApi<Label[]>('/labels');
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [color, setColor] = useState<LabelColor>('blue');
  const save = async (ids: string[]) => {
    const labels = await act(() => api.put<Label[]>(`/tasks/${taskId}/labels`, { labelIds: ids }));
    if (labels) onChange(labels);
  };
  const ids = value.map((l) => l.id);
  const matches = (all ?? []).filter((l) => !q || l.name.toLowerCase().includes(q.toLowerCase()));
  const exact = (all ?? []).some((l) => l.name.toLowerCase() === q.trim().toLowerCase());
  return (
    <div className="label-picker">
      {value.map((l) => (
        <LabelChip key={l.id} label={l} onRemove={disabled ? undefined : () => save(ids.filter((id) => id !== l.id))} />
      ))}
      {!value.length && disabled && <span className="muted small">None</span>}
      {!disabled && (
        <button type="button" className="link-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Done' : value.length ? 'Edit' : 'Add label'}
        </button>
      )}
      {open && (
        <div className="label-menu">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find or create a label" aria-label="Find or create a label" />
          <div className="label-options">
            {matches.map((l) => (
              <label key={l.id} className="check-row">
                <input type="checkbox" checked={ids.includes(l.id)} onChange={(e) => save(e.target.checked ? [...ids, l.id] : ids.filter((id) => id !== l.id))} />
                <LabelChip label={l} />
              </label>
            ))}
          </div>
          {q.trim() && !exact && (
            <form
              className="row-gap"
              onSubmit={async (e) => {
                e.preventDefault();
                const created = await act(() => api.post<Label>('/labels', { name: q.trim(), color }));
                if (!created) return;
                setQ('');
                await reload();
                await save([...ids, created.id]);
              }}
            >
              <ColorDots value={color} onChange={setColor} />
              <button className="btn sm">Create “{q.trim()}”</button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

export function ColorDots({ value, onChange }: { value: LabelColor; onChange: (c: LabelColor) => void }) {
  return (
    <span className="color-dots" role="radiogroup" aria-label="Colour">
      {LABEL_COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} className={`dot bg-${c} ${value === c ? 'on' : ''}`} onClick={() => onChange(c)} />
      ))}
    </span>
  );
}

// ---------- Custom fields ----------

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  select: 'Dropdown',
  person: 'Person',
  checkbox: 'Checkbox',
  url: 'Link',
};

/** Read-only display of a field value (tables, cards). */
export function FieldValue({ field, value }: { field: CustomField; value: unknown }) {
  const { people } = useSession();
  if (value === undefined || value === null || value === '') return <span className="muted">—</span>;
  switch (field.type) {
    case 'checkbox':
      return value ? <Icon name="check" size={14} /> : <span className="muted">—</span>;
    case 'select': {
      const opt = field.options.find((o) => o.label === value);
      return <LabelChip label={{ name: String(value), color: opt?.color ?? 'blue' }} />;
    }
    case 'person':
      return <span>{people.find((p) => p.id === value)?.name ?? 'Former member'}</span>;
    case 'url':
      return (
        <a href={String(value)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          {String(value).replace(/^https?:\/\//, '').slice(0, 40)}
        </a>
      );
    case 'number':
      return <span>{Number(value).toLocaleString()}</span>;
    default:
      return <span>{String(value)}</span>;
  }
}

/** Editable field value; saves on change/blur. */
export function FieldInput({ field, value, disabled, onSave }: { field: CustomField; value: unknown; disabled?: boolean; onSave: (value: unknown) => void }) {
  const { people } = useSession();
  const label = field.name;
  switch (field.type) {
    case 'checkbox':
      return <input type="checkbox" checked={!!value} disabled={disabled} aria-label={label} onChange={(e) => onSave(e.target.checked)} />;
    case 'select':
      return (
        <select value={(value as string) ?? ''} disabled={disabled} aria-label={label} onChange={(e) => onSave(e.target.value || null)}>
          <option value="">—</option>
          {field.options.map((o) => (
            <option key={o.label} value={o.label}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'person':
      return (
        <select value={(value as string) ?? ''} disabled={disabled} aria-label={label} onChange={(e) => onSave(e.target.value || null)}>
          <option value="">—</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      );
    case 'date':
      return <input type="date" value={(value as string) ?? ''} disabled={disabled} aria-label={label} onChange={(e) => onSave(e.target.value || null)} />;
    case 'number':
      return (
        <input
          type="number"
          className="narrow-input"
          defaultValue={(value as number) ?? ''}
          key={String(value)}
          disabled={disabled}
          aria-label={label}
          onBlur={(e) => {
            const v = e.target.value === '' ? null : Number(e.target.value);
            if (v !== (value ?? null)) onSave(v);
          }}
        />
      );
    default:
      return (
        <input
          type={field.type === 'url' ? 'url' : 'text'}
          defaultValue={(value as string) ?? ''}
          key={String(value)}
          disabled={disabled}
          aria-label={label}
          placeholder={field.type === 'url' ? 'https://' : ''}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== ((value as string) ?? '')) onSave(v || null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      );
  }
}

export function useProjectFields(projectId: string | null | undefined) {
  return useApi<CustomField[]>(projectId ? `/projects/${projectId}/fields` : null);
}

/** Custom field rows inside the task drawer's property list. */
export function TaskFieldRows({ taskId, projectId, values, disabled, onChange }: { taskId: string; projectId?: string | null; values: Record<string, unknown>; disabled: boolean; onChange: (v: Record<string, unknown>) => void }) {
  const act = useAction();
  const { data: fields } = useProjectFields(projectId);
  if (!fields?.length) return null;
  return (
    <>
      {fields.map((f) => (
        <FieldRow key={f.id} field={f}>
          <FieldInput
            field={f}
            value={values[f.id]}
            disabled={disabled}
            onSave={async (value) => {
              const res = await act(() => api.put<{ fields: Record<string, unknown> }>(`/tasks/${taskId}/fields/${f.id}`, { value }));
              if (res) onChange(res.fields);
            }}
          />
        </FieldRow>
      ))}
    </>
  );
}

function FieldRow({ field, children }: { field: CustomField; children: React.ReactNode }) {
  return (
    <>
      <dt title={FIELD_TYPE_LABEL[field.type]}>{field.name}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** Project settings: add, rename, reorder and remove custom fields. */
export function FieldsManager({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const act = useAction();
  const plan = usePlan();
  const { data: fields, reload } = useProjectFields(open ? projectId : null);
  const [name, setName] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [options, setOptions] = useState('');
  return (
    <Modal open={open} onClose={onClose} title="Custom fields" eyebrow="Project settings">
      {!plan.has('fields') ? (
        <UpgradeNotice feature="fields" />
      ) : (
        <>
          <p className="muted">Fields show on every task in this project and as columns in the table view.</p>
          <ul className="field-list">
            {fields?.map((f, i) => (
              <li key={f.id}>
                <input
                  defaultValue={f.name}
                  aria-label="Field name"
                  onBlur={async (e) => {
                    if (e.target.value.trim() && e.target.value !== f.name) await act(() => api.patch(`/fields/${f.id}`, { name: e.target.value.trim() }));
                    reload();
                  }}
                />
                <span className="pill">{FIELD_TYPE_LABEL[f.type]}</span>
                {f.type === 'select' && <small className="muted">{f.options.map((o) => o.label).join(', ')}</small>}
                <span className="grow" />
                <button
                  className="icon-btn xs"
                  aria-label={`Move ${f.name} up`}
                  disabled={i === 0}
                  onClick={async () => {
                    const order = fields.map((x) => x.id);
                    [order[i - 1], order[i]] = [order[i], order[i - 1]];
                    await act(async () => {
                      for (const [position, id] of order.entries()) await api.patch(`/fields/${id}`, { position });
                    });
                    reload();
                  }}
                >
                  <Icon name="chevronLeft" size={12} />
                </button>
                <button
                  className="icon-btn xs"
                  aria-label={`Delete ${f.name}`}
                  onClick={async () => {
                    if (!confirm(`Delete the “${f.name}” field and its values on every task?`)) return;
                    await act(() => api.del(`/fields/${f.id}`));
                    reload();
                  }}
                >
                  <Icon name="trash" size={13} />
                </button>
              </li>
            ))}
            {fields && !fields.length && <li className="muted">No fields yet.</li>}
          </ul>
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              const opts = options
                .split(',')
                .map((o) => o.trim())
                .filter(Boolean)
                .map((label, i) => ({ label, color: LABEL_COLORS[i % LABEL_COLORS.length] }));
              const ok = await act(() => api.post(`/projects/${projectId}/fields`, { name, type, options: opts }), 'Field added');
              if (!ok) return;
              setName('');
              setOptions('');
              reload();
            }}
          >
            <div className="row-gap">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New field name" aria-label="New field name" required maxLength={60} />
              <select value={type} onChange={(e) => setType(e.target.value as FieldType)} aria-label="Field type">
                {(Object.keys(FIELD_TYPE_LABEL) as FieldType[]).map((t) => (
                  <option key={t} value={t}>
                    {FIELD_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </div>
            {type === 'select' && <input value={options} onChange={(e) => setOptions(e.target.value)} placeholder="Options, separated by commas" aria-label="Dropdown options" required />}
            <div className="form-actions">
              <button className="btn primary sm" disabled={!name.trim()}>
                Add field
              </button>
            </div>
          </form>
        </>
      )}
    </Modal>
  );
}

// ---------- Time tracking ----------

/** The running timer's elapsed time, ticking each second. */
export function useElapsed(startedAt: string | null | undefined) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [startedAt]);
  if (!startedAt) return '';
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

/** Timer plus manual entries on a task. */
export function TimeTracker({ taskId, estimateHours, canLog }: { taskId: string; estimateHours: number | null; canLog: boolean }) {
  const act = useAction();
  const plan = usePlan();
  const { me } = useSession();
  const { data, reload } = useApi<{ entries: TimeEntry[]; total_minutes: number; running: TimeEntry | null }>(`/tasks/${taskId}/time`);
  const elapsed = useElapsed(data?.running?.started_at);
  const [adding, setAdding] = useState(false);
  const [hours, setHours] = useState('');
  const [date, setDate] = useState(localToday());
  const [note, setNote] = useState('');
  if (!data) return null;
  const available = plan.has('fields');
  const changed = () => {
    reload();
    window.dispatchEvent(new Event('kuu:time'));
  };
  const pct = estimateHours ? Math.min(100, Math.round((data.total_minutes / (estimateHours * 60)) * 100)) : null;
  return (
    <section className="detail-section">
      <div className="section-title">
        <h3>
          Time {data.total_minutes > 0 && <small className="muted">{duration(data.total_minutes)} logged{estimateHours ? ` of ${estimateHours}h` : ''}</small>}
        </h3>
        {canLog && available && (
          <span className="row-gap">
            {data.running ? (
              <button
                className="btn sm timer-on"
                onClick={async () => {
                  await act(() => api.post('/time/stop'));
                  changed();
                }}
              >
                <span className="rec-dot" /> {elapsed} Stop
              </button>
            ) : (
              <button
                className="btn sm"
                onClick={async () => {
                  await act(() => api.post(`/tasks/${taskId}/time/start`));
                  changed();
                }}
              >
                <Icon name="play" size={13} /> Start timer
              </button>
            )}
            <button className="link-btn" onClick={() => setAdding((a) => !a)}>
              {adding ? 'Cancel' : 'Log time'}
            </button>
          </span>
        )}
      </div>
      {pct !== null && data.total_minutes > 0 && (
        <div className={`progress ${pct >= 100 ? 'over' : ''}`} aria-label={`${pct}% of estimate`}>
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
      {!available && canLog && <UpgradeNotice feature="fields" compact />}
      {adding && (
        <form
          className="row-gap wrap"
          onSubmit={async (e) => {
            e.preventDefault();
            const minutes = Math.round(Number(hours) * 60);
            if (!minutes) return;
            const ok = await act(() => api.post(`/tasks/${taskId}/time`, { minutes, date, note }), 'Time logged');
            if (!ok) return;
            setHours('');
            setNote('');
            setAdding(false);
            changed();
          }}
        >
          <input type="number" min={0.05} max={24} step={0.25} className="narrow-input" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="hours" aria-label="Hours" required />
          <input type="date" value={date} max={localToday()} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Note" maxLength={500} className="grow" />
          <button className="btn primary sm">Add</button>
        </form>
      )}
      {data.entries.slice(0, 8).map((e) => (
        <div key={e.id} className="mini-task">
          <strong>{e.running ? elapsed || 'Running' : duration(e.minutes)}</strong>
          <span>{e.user?.name}</span>
          {e.note && <span className="muted">— {e.note}</span>}
          <small className="muted">{timeAgo(e.started_at)}</small>
          {(e.user?.id === me?.user.id || me?.role === 'admin' || me?.role === 'owner') && !e.running && (
            <button
              className="icon-btn xs"
              aria-label="Remove time entry"
              onClick={async () => {
                await act(() => api.del(`/time/${e.id}`));
                changed();
              }}
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
