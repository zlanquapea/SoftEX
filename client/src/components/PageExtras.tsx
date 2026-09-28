import { useState } from 'react';
import { api } from '../api';
import { timeAgo } from '../format';
import { useApi, useRealtime } from '../hooks';
import { useSession } from '../session';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { Modal, useAction, useToast } from './ui';

const EMOJI = ['📄', '📘', '📋', '📌', '✅', '💡', '🚀', '🎯', '📊', '🗂️', '🛠️', '🔒', '📣', '🤝', '🏥', '🎓', '💰', '🌍', '⚖️', '🧭', '🌱', '🏗️', '🧾', '🗓️'];

/** Choose an emoji for a page, Notion-style. */
export function IconPicker({ value, onChange }: { value: string | null; onChange: (icon: string | null) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="icon-picker">
      <button type="button" className={`page-emoji-btn ${value ? '' : 'empty'}`} onClick={() => setOpen((o) => !o)} aria-label={value ? 'Change page icon' : 'Add page icon'} aria-expanded={open}>
        {value ?? <Icon name="smile" size={18} />}
      </button>
      {open && (
        <span className="emoji-menu" role="listbox" aria-label="Page icon">
          {EMOJI.map((e) => (
            <button
              key={e}
              type="button"
              role="option"
              aria-selected={e === value}
              onClick={() => {
                onChange(e);
                setOpen(false);
              }}
            >
              {e}
            </button>
          ))}
          {value && (
            <button
              type="button"
              className="emoji-clear"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              Remove
            </button>
          )}
        </span>
      )}
    </span>
  );
}

interface PageComment {
  id: string;
  body: string;
  created_at: string;
  resolved_at: string | null;
  user_id: string;
  user_name: string;
  user_color: string;
}

/** Discussion under a page, with @mentions and resolve. */
export function PageComments({ pageId, canModerate, onChange }: { pageId: string; canModerate: boolean; onChange?: () => void }) {
  const act = useAction();
  const { me, people } = useSession();
  const { data, reload } = useApi<PageComment[]>(`/pages/${pageId}/comments`);
  const [body, setBody] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  useRealtime((e) => e.type === 'page.comment' && e.pageId === pageId && reload());
  const open = (data ?? []).filter((c) => !c.resolved_at);
  const resolved = (data ?? []).filter((c) => c.resolved_at);
  // "@Name" typed in the box becomes a mention when it matches someone in the workspace.
  const withMentions = (text: string) =>
    people.reduce((t, p) => t.replace(new RegExp(`@${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), `@[${p.name}](${p.id})`), text);
  const list = showResolved ? [...open, ...resolved] : open;

  return (
    <section className="card page-comments" id="comments">
      <div className="section-title">
        <h2>Comments</h2>
        {resolved.length > 0 && (
          <button className="link-btn" onClick={() => setShowResolved((s) => !s)}>
            {showResolved ? 'Hide resolved' : `Show ${resolved.length} resolved`}
          </button>
        )}
      </div>
      {!list.length && <p className="muted">No comments yet. Ask a question or suggest a change.</p>}
      {list.map((c) => (
        <div key={c.id} className={`comment ${c.resolved_at ? 'resolved' : ''}`}>
          <Avatar user={{ id: c.user_id, name: c.user_name, color: c.user_color }} size="sm" />
          <div className="grow">
            <strong>{c.user_name}</strong> <small className="muted">{timeAgo(c.created_at)}</small>
            {c.resolved_at && <span className="pill">Resolved</span>}
            <Markdown text={c.body} compact />
          </div>
          {(canModerate || c.user_id === me!.user.id) && (
            <button
              className="link-btn small"
              onClick={async () => {
                await act(() => api.patch(`/page-comments/${c.id}`, { resolved: !c.resolved_at }));
                reload();
              }}
            >
              {c.resolved_at ? 'Reopen' : 'Resolve'}
            </button>
          )}
          {(c.user_id === me!.user.id || me!.role === 'admin' || me!.role === 'owner') && (
            <button
              className="icon-btn xs"
              aria-label="Delete comment"
              onClick={async () => {
                if (!confirm('Delete this comment?')) return;
                await act(() => api.del(`/page-comments/${c.id}`));
                reload();
                onChange?.();
              }}
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      ))}
      <form
        className="comment-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!body.trim()) return;
          const ok = await act(() => api.post(`/pages/${pageId}/comments`, { body: withMentions(body.trim()) }));
          if (!ok) return;
          setBody('');
          reload();
          onChange?.();
        }}
      >
        <Avatar user={me!.user} size="sm" />
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Comment… use @Name to mention someone" aria-label="Comment on this page" maxLength={5000} />
        <button className="btn sm" disabled={!body.trim()}>
          Post
        </button>
      </form>
    </section>
  );
}

/** Publish a page as a read-only web link anyone can open. */
export function PublishPanel({ open, onClose, pageId, isPublic, url, onChange }: { open: boolean; onClose: () => void; pageId: string; isPublic: boolean; url: string | null; onChange: () => void }) {
  const act = useAction();
  const toast = useToast();
  const set = async (makePublic: boolean, newLink = false) => {
    await act(() => api.post(`/pages/${pageId}/publish`, { public: makePublic, newLink }), makePublic ? (newLink ? 'New link created' : 'Page published') : 'Page unpublished');
    onChange();
  };
  return (
    <Modal open={open} onClose={onClose} title="Publish to the web" eyebrow="Share">
      <div className="stack">
        <p className="muted">
          Anyone with the link can read this page — no Küü account needed. They can’t see comments, history or other pages. Search engines are asked not to index it.
        </p>
        {isPublic && url ? (
          <>
            <div className="row-gap">
              <input readOnly value={url} aria-label="Public link" onFocus={(e) => e.target.select()} className="grow" />
              <button
                className="btn sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(url);
                    toast('Link copied');
                  } catch {
                    /* the field is selectable */
                  }
                }}
              >
                Copy
              </button>
            </div>
            <div className="form-actions">
              <button className="btn" onClick={() => set(true, true)}>
                New link
              </button>
              <button className="btn danger-text" onClick={() => set(false)}>
                Unpublish
              </button>
            </div>
          </>
        ) : (
          <div className="form-actions">
            <button className="btn primary" onClick={() => set(true)}>
              <Icon name="globe" size={15} /> Publish
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
