import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLiveDoc, useYText, type Peer, type SaveStatus } from '../collab';
import { useRealtime } from '../hooks';
import { Avatar } from './Avatar';
import { Markdown } from './Markdown';
import { Loading, useAction } from './ui';

const STATUS_TEXT: Record<SaveStatus, string> = {
  connecting: 'Connecting…',
  saving: 'Sharing changes…',
  saved: 'Changes shared live',
  offline: 'Offline — your changes will be shared when you reconnect',
};

export function PeerList({ peers, label = 'Also editing' }: { peers: Peer[]; label?: string }) {
  // One entry per person, even with several tabs open.
  const people = [...new Map(peers.map((p) => [p.user.id, p.user])).values()];
  if (!people.length) return null;
  return (
    <span className="peer-list" aria-label={`${label}: ${people.map((p) => p.name).join(', ')}`}>
      <small className="muted">{label}</small>
      {people.map((u) => (
        <span key={u.id} className="peer" title={u.name}>
          <Avatar user={u} size="xs" />
        </span>
      ))}
    </span>
  );
}

/**
 * The page editor: title and Markdown body are shared live with everyone editing the page.
 * "Save version" records the shared text in the page's history and makes it the published copy.
 */
export function LiveEditor({
  page,
  onClose,
  onSaved,
}: {
  page: { id: string; title: string; body: string; version: number };
  onClose: () => void;
  onSaved: () => void;
}) {
  const act = useAction();
  const live = useLiveDoc('page', page.id);
  const title = useYText(live, 'title');
  const body = useYText(live, 'body');
  const [preview, setPreview] = useState(false);

  if (!live || !live.ready) return <Loading label="Opening the live editor" />;
  const changed = title.value !== page.title || body.value !== page.body;
  const peers = [...live.peers.values()];
  const others = (field: 'title' | 'body') => peers.filter((p) => p.selection?.field === field);
  const track = (field: 'title' | 'body') => (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) =>
    live.setPresence({ selection: { field, start: e.currentTarget.selectionStart ?? 0, end: e.currentTarget.selectionEnd ?? 0 } });

  return (
    <div className="editor card">
      <div className="live-bar">
        <span className={`live-status ${live.status}`} role="status">
          <i /> {STATUS_TEXT[live.status]}
        </span>
        <PeerList peers={peers} />
      </div>
      <input
        ref={title.ref}
        className="title-input"
        value={title.value}
        onChange={(e) => title.onChange(e.target.value)}
        onSelect={track('title')}
        readOnly={!live.canEdit}
        aria-label="Page title"
      />
      {others('title').length > 0 && <PeerList peers={others('title')} label="In the title" />}
      <div className="segmented" role="group">
        <button className={!preview ? 'active' : ''} onClick={() => setPreview(false)}>
          Write
        </button>
        <button className={preview ? 'active' : ''} onClick={() => setPreview(true)}>
          Preview
        </button>
      </div>
      {preview ? (
        <Markdown text={body.value} />
      ) : (
        <textarea
          ref={body.ref}
          className="page-editor"
          value={body.value}
          onChange={(e) => body.onChange(e.target.value)}
          onSelect={track('body')}
          readOnly={!live.canEdit}
          rows={20}
          aria-label="Page content"
          placeholder={'# Heading\n\nWrite with **Markdown**. Link tasks and discussions by pasting their Küü links.\n\n- [ ] Checklists work too'}
        />
      )}
      <p className="muted small">
        Everyone editing sees each other’s changes as they type. Readers see the last saved version until someone saves.
      </p>
      <div className="form-actions">
        <button className="btn" onClick={onClose}>
          {changed ? 'Close (keep shared draft)' : 'Close'}
        </button>
        <button
          className="btn primary"
          disabled={!changed || !title.value.trim() || !live.canEdit}
          onClick={async () => {
            await live.flush();
            const ok = await act(() => api.patch(`/pages/${page.id}`, { title: title.value.trim(), body: body.value }), 'Page saved');
            if (ok) onSaved();
          }}
        >
          Save version {page.version + (changed ? 1 : 0)}
        </button>
      </div>
    </div>
  );
}

/** People editing a page right now, for readers of the saved version. */
export function useEditingNow(pageId: string) {
  const [peers, setPeers] = useState<Map<string, Peer>>(new Map());
  useRealtime((e) => {
    if (e.type !== 'collab.presence' || e.key !== `page:${pageId}`) return;
    setPeers((prev) => {
      const next = new Map(prev);
      if (e.active) next.set(e.clientId, { clientId: e.clientId, user: e.user, cursor: null, selection: e.selection, at: Date.now() });
      else next.delete(e.clientId);
      return next;
    });
  });
  useEffect(() => {
    const t = window.setInterval(() => setPeers((prev) => new Map([...prev].filter(([, p]) => p.at > Date.now() - 30_000))), 10_000);
    return () => window.clearInterval(t);
  }, []);
  return [...peers.values()];
}
