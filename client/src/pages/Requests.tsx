import { useState } from 'react';
import { api } from '../api';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { Empty, ErrorState, Field, Loading, Modal, Tabs, useAction } from '../components/ui';
import { timeAgo } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';

interface Request {
  id: string;
  kind: string;
  title: string;
  details: string;
  requester_id: string;
  requester_name: string;
  requester_color: string;
  approver_id: string;
  approver_name: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  resolution_note: string;
  decided_at: string | null;
  created_at: string;
}

const KIND_LABEL: Record<string, string> = { access: 'Access', purchase: 'Purchase', leave: 'Leave handoff', support: 'Internal support', other: 'Other' };

export function Requests() {
  const { me, people } = useSession();
  const act = useAction();
  const [tab, setTab] = useState<'inbox' | 'mine'>('inbox');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ kind: 'purchase', title: '', details: '', approverId: '' });
  const [note, setNote] = useState<Record<string, string>>({});
  const { data, error, reload } = useApi<Request[]>('/requests');
  const list = (data ?? []).filter((r) => (tab === 'inbox' ? r.approver_id === me!.user.id : r.requester_id === me!.user.id));
  const pending = (data ?? []).filter((r) => r.approver_id === me!.user.id && r.status === 'pending').length;

  const decide = async (r: Request, status: 'approved' | 'rejected' | 'cancelled') => {
    await act(() => api.post(`/requests/${r.id}/decide`, { status, note: note[r.id] ?? '' }), `Request ${status}`);
    reload();
  };

  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>Requests & approvals</h1>
          <p className="muted">Lightweight approvals for access, purchases, leave handoffs and internal support.</p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={16} /> New request
        </button>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'inbox', label: 'To approve', count: pending }, { id: 'mine', label: 'My requests' }]} />
      {error && <ErrorState error={error} retry={reload} />}
      {!data && !error && <Loading />}
      {data && !list.length && <Empty icon="inboxCheck" title={tab === 'inbox' ? 'Nothing waiting for you' : 'You have not made any requests'} />}
      {list.map((r) => (
        <article key={r.id} className={`card request ${r.status}`}>
          <div className="update-head">
            <Avatar user={{ id: r.requester_id, name: r.requester_name, color: r.requester_color }} size="sm" />
            <strong>{r.title}</strong>
            <span className="pill">{KIND_LABEL[r.kind]}</span>
            <span className={`pill req-${r.status}`}>{r.status}</span>
            <span className="grow" />
            <small className="muted">{timeAgo(r.created_at)}</small>
          </div>
          <p className="muted small">
            {r.requester_name} → {r.approver_name}
          </p>
          {r.details && <p>{r.details}</p>}
          {r.resolution_note && (
            <p className="hint-box">
              <strong>{r.approver_name}:</strong> {r.resolution_note}
            </p>
          )}
          {r.status === 'pending' && r.approver_id === me!.user.id && (
            <div className="request-actions">
              <input placeholder="Optional note" value={note[r.id] ?? ''} onChange={(e) => setNote({ ...note, [r.id]: e.target.value })} aria-label="Note" />
              <button className="btn" onClick={() => decide(r, 'rejected')}>
                Decline
              </button>
              <button className="btn primary" onClick={() => decide(r, 'approved')}>
                Approve
              </button>
            </div>
          )}
          {r.status === 'pending' && r.requester_id === me!.user.id && (
            <button className="btn sm" onClick={() => decide(r, 'cancelled')}>
              Cancel request
            </button>
          )}
        </article>
      ))}
      <Modal open={creating} onClose={() => setCreating(false)} title="New request">
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await act(() => api.post('/requests', form), 'Request sent');
            if (ok) {
              setCreating(false);
              setForm({ kind: 'purchase', title: '', details: '', approverId: '' });
              setTab('mine');
              reload();
            }
          }}
        >
          <div className="form-row">
            <Field label="Type">
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {Object.entries(KIND_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Approver">
              <select required value={form.approverId} onChange={(e) => setForm({ ...form, approverId: e.target.value })}>
                <option value="">Choose…</option>
                {people
                  .filter((p) => p.id !== me!.user.id && p.role !== 'guest')
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          <Field label="What do you need?">
            <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Figma licence for the design contractor" />
          </Field>
          <Field label="Details">
            <textarea rows={4} value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} placeholder="Cost, dates, justification, links to the system of record…" />
          </Field>
          <div className="form-actions">
            <button className="btn primary">Send request</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
