import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { Avatar } from './Avatar';

// ---------- Toasts ----------

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}
const ToastContext = createContext<(text: string, tone?: 'info' | 'error') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 5000 : 2600);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** Wrap an async action: show API errors as toasts. */
export function useAction() {
  const toast = useToast();
  return useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      try {
        const result = await fn();
        if (success) toast(success);
        return result;
      } catch (e) {
        toast((e as Error).message || 'Something went wrong', 'error');
        return undefined;
      }
    },
    [toast],
  );
}

// ---------- Modal ----------

export function Modal({
  open,
  onClose,
  title,
  eyebrow,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="modal-title"
    >
      {open && (
        <div className="modal-body">
          <button className="icon-btn modal-close" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h2 id="modal-title">{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

// ---------- Small building blocks ----------

export function Empty({ icon = 'spark', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <strong>{title}</strong>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="sr-only">{label}…</span>
    </div>
  );
}

export function ErrorState({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <div className="empty">
      <span className="empty-icon danger">
        <Icon name="alert" size={22} />
      </span>
      <strong>{(error as any).status === 404 ? 'Not found, or you do not have access' : 'Could not load this'}</strong>
      <div className="muted">{error.message}</div>
      {retry && (
        <button className="btn" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'active' : ''} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count ? <span className="tab-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

// ---------- People picker ----------

export interface PickablePerson {
  id: string;
  name: string;
  color?: string;
  title?: string;
  role?: string;
}

export function PeoplePicker({
  people,
  value,
  onChange,
  placeholder = 'Add people…',
  exclude = [],
}: {
  people: PickablePerson[];
  value: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  exclude?: string[];
}) {
  const [q, setQ] = useState('');
  const selected = people.filter((p) => value.includes(p.id));
  const options = people
    .filter((p) => !value.includes(p.id) && !exclude.includes(p.id))
    .filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 6);
  return (
    <div className="people-picker">
      <div className="chips">
        {selected.map((p) => (
          <span className="chip" key={p.id}>
            <Avatar user={p} size="xs" /> {p.name}
            <button type="button" aria-label={`Remove ${p.name}`} onClick={() => onChange(value.filter((v) => v !== p.id))}>
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      </div>
      {q && (
        <div className="picker-options">
          {options.map((p) => (
            <button
              type="button"
              key={p.id}
              onClick={() => {
                onChange([...value, p.id]);
                setQ('');
              }}
            >
              <Avatar user={p} size="xs" /> {p.name} {p.title && <small className="muted">{p.title}</small>}
            </button>
          ))}
          {!options.length && <span className="muted pad">No matches</span>}
        </div>
      )}
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const label: Record<string, string> = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', review: 'In review', done: 'Done' };
  return <span className={`pill status-${status}`}>{label[status] ?? status}</span>;
}

export function HealthPill({ health }: { health: string }) {
  const label: Record<string, string> = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track' };
  return (
    <span className={`health health-${health}`}>
      <i />
      {label[health] ?? health}
    </span>
  );
}
