import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../lib/api';
import { useLiveDoc, useYText, type Peer, type SaveStatus } from '../lib/collab';
import { timeAgo } from '../lib/format';
import { useApi, useRealtime } from '../lib/hooks';
import { useSession } from '../lib/session';
import { useTheme } from '../lib/theme';
import { Icon } from './Icon';
import { Avatar, Button, Card, confirm, Input, LinkText, Loading, Muted, Pill, Row, Segmented, Sheet, T, useAction, useToast } from './kit';
import { Markdown } from './Markdown';

const EMOJI = ['📄', '📘', '📋', '📌', '✅', '💡', '🚀', '🎯', '📊', '🗂️', '🛠️', '🔒', '📣', '🤝', '🏥', '🎓', '💰', '🌍', '⚖️', '🧭', '🌱', '🏗️', '🧾', '🗓️'];

export function IconPicker({ value, onChange }: { value: string | null; onChange: (icon: string | null) => void }) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={value ? 'Change page icon' : 'Add page icon'} style={{ width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: value ? 'transparent' : c.line2 }}>
        {value ? <T size={30}>{value}</T> : <Icon name="smile" size={20} color={c.muted} />}
      </Pressable>
      <Sheet open={open} onClose={() => setOpen(false)} title="Page icon">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {EMOJI.map((e) => (
            <Pressable
              key={e}
              onPress={() => {
                onChange(e);
                setOpen(false);
              }}
              accessibilityLabel={e}
              accessibilityState={{ selected: e === value }}
              style={{ width: 48, height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: e === value ? c.accentSoft : c.surface }}
            >
              <T size={26}>{e}</T>
            </Pressable>
          ))}
        </View>
        {value && (
          <Button
            title="Remove icon"
            onPress={() => {
              onChange(null);
              setOpen(false);
            }}
          />
        )}
      </Sheet>
    </>
  );
}

export function PeerList({ peers, label = 'Also editing' }: { peers: Peer[]; label?: string }) {
  const people = [...new Map(peers.map((p) => [p.user.id, p.user])).values()];
  if (!people.length) return null;
  return (
    <Row gap={6} accessibilityLabel={`${label}: ${people.map((p) => p.name).join(', ')}`}>
      <Muted size={12}>{label}</Muted>
      {people.map((u) => (
        <Avatar key={u.id} user={u} size="xs" />
      ))}
    </Row>
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
    const t = setInterval(() => setPeers((prev) => new Map([...prev].filter(([, p]) => p.at > Date.now() - 30_000))), 10_000);
    return () => clearInterval(t);
  }, []);
  return [...peers.values()];
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

export function PageComments({ pageId, canModerate, onChange }: { pageId: string; canModerate: boolean; onChange?: () => void }) {
  const { c } = useTheme();
  const act = useAction();
  const { me, people } = useSession();
  const { data, reload } = useApi<PageComment[]>(`/pages/${pageId}/comments`);
  const [body, setBody] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  useRealtime((e) => e.type === 'page.comment' && e.pageId === pageId && reload());
  const open = (data ?? []).filter((x) => !x.resolved_at);
  const resolved = (data ?? []).filter((x) => x.resolved_at);
  const withMentions = (text: string) => people.reduce((t, p) => t.replace(new RegExp(`@${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), `@[${p.name}](${p.id})`), text);
  const list = showResolved ? [...open, ...resolved] : open;
  return (
    <Card style={{ gap: 12 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T size={17} weight="display">
          Comments
        </T>
        {resolved.length > 0 && <LinkText onPress={() => setShowResolved((s) => !s)}>{showResolved ? 'Hide resolved' : `Show ${resolved.length} resolved`}</LinkText>}
      </Row>
      {!list.length && <Muted>No comments yet. Ask a question or suggest a change.</Muted>}
      {list.map((cm) => (
        <Row key={cm.id} gap={10} style={{ alignItems: 'flex-start', opacity: cm.resolved_at ? 0.6 : 1 }}>
          <Avatar user={{ id: cm.user_id, name: cm.user_name, color: cm.user_color }} size="sm" />
          <View style={{ flex: 1, gap: 2 }}>
            <Row gap={6} wrap>
              <T size={14} weight="bold">
                {cm.user_name}
              </T>
              <Muted size={12}>{timeAgo(cm.created_at)}</Muted>
              {cm.resolved_at && <Pill label="Resolved" />}
            </Row>
            <Markdown text={cm.body} compact size={14} />
            <Row gap={14}>
              {(canModerate || cm.user_id === me!.user.id) && (
                <LinkText
                  size={13}
                  onPress={async () => {
                    await act(() => api.patch(`/page-comments/${cm.id}`, { resolved: !cm.resolved_at }));
                    reload();
                  }}
                >
                  {cm.resolved_at ? 'Reopen' : 'Resolve'}
                </LinkText>
              )}
              {(cm.user_id === me!.user.id || me!.role === 'admin' || me!.role === 'owner') && (
                <LinkText
                  size={13}
                  tone="red"
                  onPress={async () => {
                    if (!(await confirm('Delete this comment?', undefined, 'Delete'))) return;
                    await act(() => api.del(`/page-comments/${cm.id}`));
                    reload();
                    onChange?.();
                  }}
                >
                  Delete
                </LinkText>
              )}
            </Row>
          </View>
        </Row>
      ))}
      <Row gap={8} style={{ borderTopWidth: 1, borderColor: c.line2, paddingTop: 10 }}>
        <Avatar user={me!.user} size="sm" />
        <Input value={body} onChangeText={setBody} placeholder="Comment… use @Name to mention someone" accessibilityLabel="Comment on this page" maxLength={5000} multiline style={{ flex: 1 }} />
        <Button
          small
          title="Post"
          disabled={!body.trim()}
          onPress={async () => {
            const ok = await act(() => api.post(`/pages/${pageId}/comments`, { body: withMentions(body.trim()) }));
            if (!ok) return;
            setBody('');
            reload();
            onChange?.();
          }}
        />
      </Row>
    </Card>
  );
}

export function PublishSheet({ open, onClose, pageId, isPublic, url, onChange }: { open: boolean; onClose: () => void; pageId: string; isPublic: boolean; url: string | null; onChange: () => void }) {
  const { c } = useTheme();
  const act = useAction();
  const toast = useToast();
  const set = async (makePublic: boolean, newLink = false) => {
    await act(() => api.post(`/pages/${pageId}/publish`, { public: makePublic, newLink }), makePublic ? (newLink ? 'New link created' : 'Page published') : 'Page unpublished');
    onChange();
  };
  return (
    <Sheet open={open} onClose={onClose} title="Publish to the web" eyebrow="Share">
      <Muted>Anyone with the link can read this page — no Küü account needed. They can’t see comments, history or other pages. Search engines are asked not to index it.</Muted>
      {isPublic && url ? (
        <>
          <View style={{ padding: 12, borderRadius: 10, backgroundColor: c.sunken }}>
            <T size={13} selectable>
              {url}
            </T>
          </View>
          <Row wrap>
            <Button
              small
              icon="link"
              title="Copy link"
              onPress={async () => {
                await Clipboard.setStringAsync(url);
                toast('Link copied');
              }}
            />
            <Button small title="New link" onPress={() => set(true, true)} />
            <Button small variant="danger" title="Unpublish" onPress={() => set(false)} />
          </Row>
        </>
      ) : (
        <Button variant="primary" icon="globe" title="Publish" onPress={() => set(true)} />
      )}
    </Sheet>
  );
}

const STATUS_TEXT: Record<SaveStatus, string> = {
  connecting: 'Connecting…',
  saving: 'Sharing changes…',
  saved: 'Changes shared live',
  offline: 'Offline — your changes will be shared when you reconnect',
};

/** The page editor: title and Markdown body are shared live with everyone editing the page. */
export function LiveEditor({ page, onClose, onSaved }: { page: { id: string; title: string; body: string; version: number }; onClose: () => void; onSaved: () => void }) {
  const { c } = useTheme();
  const act = useAction();
  const live = useLiveDoc('page', page.id);
  const title = useYText(live, 'title');
  const body = useYText(live, 'body');
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  if (!live || !live.ready) return <Loading label="Opening the live editor" inline />;
  const changed = title.value !== page.title || body.value !== page.body;
  const peers = [...live.peers.values()];
  const dot = { saved: c.green, saving: c.amber, connecting: c.muted, offline: c.red }[live.status];
  return (
    <Card style={{ gap: 12 }}>
      <Row style={{ justifyContent: 'space-between' }} wrap>
        <Row gap={6} accessibilityLiveRegion="polite">
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
          <Muted size={12}>{STATUS_TEXT[live.status]}</Muted>
        </Row>
        <PeerList peers={peers} />
      </Row>
      <Input
        value={title.value}
        onChangeText={title.onChange}
        editable={live.canEdit}
        accessibilityLabel="Page title"
        onFocus={() => live.setPresence({ selection: { field: 'title', start: 0, end: 0 } })}
        style={{ fontSize: 20, fontFamily: 'Manrope_700Bold' }}
      />
      <Segmented
        value={mode}
        onChange={setMode}
        options={[
          { id: 'write', label: 'Write' },
          { id: 'preview', label: 'Preview' },
        ]}
      />
      {mode === 'preview' ? (
        <Markdown text={body.value} />
      ) : (
        <Input
          multiline
          value={body.value}
          onChangeText={body.onChange}
          editable={live.canEdit}
          accessibilityLabel="Page content"
          onFocus={() => live.setPresence({ selection: { field: 'body', start: 0, end: 0 } })}
          placeholder={'# Heading\n\nWrite with **Markdown**. Link tasks and discussions by pasting their Küü links.\n\n- [ ] Checklists work too'}
          style={{ minHeight: 320, fontSize: 15 }}
        />
      )}
      <Muted size={12}>Everyone editing sees each other’s changes as they type. Readers see the last saved version until someone saves.</Muted>
      <Row style={{ justifyContent: 'flex-end' }} wrap>
        <Button title={changed ? 'Close (keep shared draft)' : 'Close'} onPress={onClose} />
        <Button
          variant="primary"
          title={`Save version ${page.version + (changed ? 1 : 0)}`}
          disabled={!changed || !title.value.trim() || !live.canEdit}
          onPress={async () => {
            await live.flush();
            const ok = await act(() => api.patch(`/pages/${page.id}`, { title: title.value.trim(), body: body.value }), 'Page saved');
            if (ok) onSaved();
          }}
        />
      </Row>
    </Card>
  );
}

