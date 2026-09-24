import { useState } from 'react';
import { api } from '../api';
import { dateTime } from '../format';
import { Icon } from './Icon';
import { Field, Modal, useAction } from './ui';

/** Quick choices for "later": in 20 minutes, in an hour, this evening, tomorrow morning, next Monday. */
export function laterPresets(from = new Date()) {
  const at = (d: Date, h: number, m = 0) => {
    const x = new Date(d);
    x.setHours(h, m, 0, 0);
    return x;
  };
  const plus = (ms: number) => new Date(from.getTime() + ms);
  const tomorrow = new Date(from);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const monday = new Date(from);
  monday.setDate(monday.getDate() + (((8 - monday.getDay()) % 7) || 7));
  const list = [
    { label: 'In 20 minutes', date: plus(20 * 60_000) },
    { label: 'In 1 hour', date: plus(60 * 60_000) },
    { label: 'In 3 hours', date: plus(3 * 60 * 60_000) },
    { label: 'Tomorrow morning', date: at(tomorrow, 9) },
    { label: 'Next Monday', date: at(monday, 9) },
  ];
  const evening = at(from, 17);
  if (evening.getTime() - from.getTime() > 60 * 60_000) list.splice(3, 0, { label: 'This evening', date: evening });
  return list;
}

const toLocalInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** A modal that asks "when?" with quick presets and a custom date/time. */
export function WhenModal({
  open,
  onClose,
  title,
  eyebrow,
  confirmLabel,
  withNote,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  confirmLabel: string;
  withNote?: boolean;
  onPick: (iso: string, note: string) => Promise<unknown>;
}) {
  const [custom, setCustom] = useState(() => toLocalInput(new Date(Date.now() + 2 * 60 * 60_000)));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const pick = async (d: Date) => {
    setBusy(true);
    const ok = await onPick(d.toISOString(), note);
    setBusy(false);
    if (ok) {
      setNote('');
      onClose();
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={title} eyebrow={eyebrow}>
      {withNote && (
        <Field label="Note (optional)">
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="What should you remember?" />
        </Field>
      )}
      <div className="later-presets">
        {laterPresets().map((p) => (
          <button key={p.label} className="later-preset" disabled={busy} onClick={() => pick(p.date)}>
            <strong>{p.label}</strong>
            <small className="muted">{dateTime(p.date.toISOString())}</small>
          </button>
        ))}
      </div>
      <form
        className="row-gap wrap later-custom"
        onSubmit={(e) => {
          e.preventDefault();
          const d = new Date(custom);
          if (!Number.isNaN(d.getTime())) pick(d);
        }}
      >
        <Field label="Or pick a date and time">
          <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} required />
        </Field>
        <button className="btn primary" disabled={busy}>
          {confirmLabel}
        </button>
      </form>
    </Modal>
  );
}

/** "Remind me" for a message or task (or a free-form note when neither is given). */
export function RemindModal({ open, onClose, messageId, taskId }: { open: boolean; onClose: () => void; messageId?: string; taskId?: string }) {
  const act = useAction();
  return (
    <WhenModal
      open={open}
      onClose={onClose}
      eyebrow="REMINDER"
      title="Remind me about this"
      confirmLabel="Set reminder"
      withNote
      onPick={(iso, note) =>
        act(
          () => api.post('/reminders', { remindAt: iso, note, messageId, taskId }),
          `Reminder set for ${dateTime(iso)}`,
        )
      }
    />
  );
}

export function RemindButton({ taskId, messageId, label = 'Remind me' }: { taskId?: string; messageId?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)}>
        <Icon name="clock" size={14} /> {label}
      </button>
      <RemindModal open={open} onClose={() => setOpen(false)} taskId={taskId} messageId={messageId} />
    </>
  );
}
