import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { api } from '@/lib/api';
import { dateLabel, dateTime, plainMentions, timeAgo } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { storage } from '@/lib/storage';
import { useTheme } from '@/lib/theme';
import { FavoriteButton } from '@/ui/chat';
import { Icon } from '@/ui/Icon';
import { ActionSheet, Button, Card, ErrorState, Field, H1, IconButton, LinkText, ListRow, Loading, Muted, Pill, Row, Screen, Section, Select, Sheet, T, useAction } from '@/ui/kit';
import { Markdown } from '@/ui/Markdown';
import { IconPicker, LiveEditor, PageComments, PeerList, PublishSheet, useEditingNow } from '@/ui/pages';
import { DateField, PeopleField } from '@/ui/pickers';
import type { PageSummary } from './index';

interface PageFull extends PageSummary {
  body: string;
  project: { id: string; name: string; color: string } | null;
  versions: { version: number; title: string; created_at: string; edited_by_name: string }[];
  discussions: { id: string; body: string; created_at: string; channel_id: string; channel_name: string; user_name: string }[];
  can_edit: boolean;
  archived_at: string | null;
  breadcrumbs: { id: string; title: string; icon: string | null }[];
  children: { id: string; title: string; icon: string | null }[];
  comment_count: number;
  public_url: string | null;
}

export default function PageView() {
  const { id, edit } = useLocalSearchParams<{ id: string; edit?: string }>();
  const { c } = useTheme();
  const { me, people } = useSession();
  const act = useAction();
  const { data: page, error, reload, refresh, refreshing } = useApi<PageFull>(`/pages/${id}`);
  const [editing, setEditing] = useState(edit === '1');
  const [version, setVersion] = useState<{ version: number; title: string; body: string } | null>(null);
  const [history, setHistory] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [settings, setSettings] = useState(false);
  const { data: allPages } = useApi<PageSummary[]>(page?.can_edit ? '/pages' : null);
  const editingNow = useEditingNow(id);
  if (error && !page) return <ErrorState error={error} retry={reload} />;
  if (!page) return <Loading />;

  const addSubPage = async () => {
    const child = await act(() => api.post<{ id: string }>('/pages', { title: 'Untitled', parentId: page.id }));
    if (child) router.push(`/knowledge/${child.id}?edit=1`);
  };
  const descendants = new Set<string>([page.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of allPages ?? []) {
      if (p.parent_id && descendants.has(p.parent_id) && !descendants.has(p.id)) {
        descendants.add(p.id);
        grew = true;
      }
    }
  }
  const askOwner = async () => {
    if (!page.owner || page.owner.id === me!.user.id) return;
    const dm = await act(() => api.post<{ id: string }>('/dms', { userIds: [page.owner!.id] }));
    if (dm) {
      await storage.set(`kuu.draft.${dm.id}.root`, `Question about [${page.title}](/knowledge/${page.id}): `);
      router.push(`/channels/${dm.id}`);
    }
  };
  const canArchive = page.owner?.id === me!.user.id || me!.role === 'admin' || me!.role === 'owner';

  return (
    <>
      <Stack.Screen
        options={{
          title: page.project?.name ?? 'Knowledge',
          headerRight: () => (
            <Row gap={0}>
              <FavoriteButton kind="page" id={page.id} />
              {!editing && <IconButton name="more" label="Page options" onPress={() => setMenu(true)} />}
            </Row>
          ),
        }}
      />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        {page.breadcrumbs.length > 0 && (
          <Row wrap gap={4}>
            {page.breadcrumbs.map((b) => (
              <LinkText key={b.id} size={13} onPress={() => router.push(`/knowledge/${b.id}`)}>
                {b.icon ? `${b.icon} ` : ''}
                {b.title} /
              </LinkText>
            ))}
          </Row>
        )}
        {editing ? (
          <LiveEditor
            page={page}
            onClose={() => {
              setEditing(false);
              reload();
            }}
            onSaved={() => {
              setEditing(false);
              reload();
            }}
          />
        ) : (
          <Card style={{ gap: 12 }}>
            <Row wrap gap={6}>
              {page.status === 'approved' ? <Pill label="Approved" tone="green" /> : <Pill label="Draft" />}
              {page.needs_review && <Pill label="Review due" tone="red" />}
              {page.archived_at && <Pill label="Archived" />}
              {page.public && <Pill label="Published" icon="globe" tone="blue" />}
            </Row>
            <Row gap={10} style={{ alignItems: 'flex-start' }}>
              {page.can_edit ? (
                <IconPicker
                  value={page.icon}
                  onChange={async (icon) => {
                    await act(() => api.patch(`/pages/${page.id}`, { icon }));
                    reload();
                  }}
                />
              ) : (
                page.icon && <T size={30}>{page.icon}</T>
              )}
              <H1 style={{ flex: 1 }}>{page.title}</H1>
            </Row>
            <Muted size={12}>
              Owner <T size={12} weight="bold">{page.owner?.name}</T> · version {page.version} · updated {timeAgo(page.updated_at)} by {page.updated_by?.name}
              {page.review_date ? ` · review by ${dateLabel(page.review_date)}` : ''}
            </Muted>
            {editingNow.length > 0 && (
              <Row wrap>
                <PeerList peers={editingNow} label="Editing now" />
                {page.can_edit && <LinkText onPress={() => setEditing(true)}>Join them</LinkText>}
              </Row>
            )}
            <Row wrap>
              {page.can_edit && <Button small icon="edit" title="Edit" onPress={() => setEditing(true)} />}
              {page.owner && page.owner.id !== me!.user.id && <Button small icon="chat" title="Ask the owner" onPress={askOwner} />}
            </Row>
            <View style={{ height: 1, backgroundColor: c.line2 }} />
            {page.body ? <Markdown text={page.body} /> : <Muted>This page is empty.</Muted>}
          </Card>
        )}
        {page.children.length > 0 && (
          <Section title="Sub-pages">
            {page.children.map((ch) => (
              <ListRow key={ch.id} left={ch.icon ? <T size={18}>{ch.icon}</T> : <Icon name="file" size={17} color={c.ink2} />} title={ch.title} chevron onPress={() => router.push(`/knowledge/${ch.id}`)} />
            ))}
          </Section>
        )}
        {!editing && <PageComments pageId={page.id} canModerate={page.can_edit} onChange={reload} />}
        {page.discussions.length > 0 && (
          <Section title="Related discussions">
            {page.discussions.map((d) => (
              <ListRow
                key={d.id}
                left={<Icon name="chat" size={17} color={c.ink2} />}
                title={`${d.user_name} in #${d.channel_name}`}
                subtitle={`${plainMentions(d.body).slice(0, 160)} · ${timeAgo(d.created_at)}`}
                onPress={() => router.push(`/channels/${d.channel_id}?message=${d.id}`)}
              />
            ))}
          </Section>
        )}
      </Screen>
      <ActionSheet
        open={menu}
        onClose={() => setMenu(false)}
        title={page.title}
        actions={[
          { label: 'Edit', icon: 'edit', onPress: () => setEditing(true), hidden: !page.can_edit },
          { label: `History (${page.versions.length})`, icon: 'clock', onPress: () => setHistory(true) },
          { label: 'Add a sub-page', icon: 'plus', onPress: addSubPage, hidden: !page.can_edit },
          { label: page.public ? 'Published to the web' : 'Publish to the web', icon: 'globe', onPress: () => setSharing(true), hidden: !page.can_edit || me!.role === 'guest' },
          { label: 'Page settings', icon: 'settings', onPress: () => setSettings(true), hidden: !page.can_edit },
          { label: 'Open project', icon: 'folder', onPress: () => router.push(`/projects/${page.project!.id}?tab=resources`), hidden: !page.project },
          {
            label: page.archived_at ? 'Restore page' : 'Archive page',
            icon: 'flag',
            danger: !page.archived_at,
            hidden: !page.can_edit || !canArchive,
            onPress: async () => {
              await act(() => api.post(`/pages/${page.id}/archive`, { archived: !page.archived_at }), page.archived_at ? 'Page restored' : 'Page archived');
              if (page.archived_at) reload();
              else router.back();
            },
          },
        ]}
      />
      <PublishSheet open={sharing} onClose={() => setSharing(false)} pageId={page.id} isPublic={page.public} url={page.public_url} onChange={reload} />
      <Sheet open={history} onClose={() => setHistory(false)} title="Version history">
        <View>
          {page.versions.map((v) => (
            <ListRow
              key={v.version}
              title={`Version ${v.version}`}
              subtitle={`${v.edited_by_name} · ${dateTime(v.created_at)}`}
              chevron
              onPress={async () => {
                const full = await act(() => api.get<{ version: number; title: string; body: string }>(`/pages/${page.id}/versions/${v.version}`));
                if (full) {
                  setHistory(false);
                  setTimeout(() => setVersion(full), 300);
                }
              }}
            />
          ))}
        </View>
      </Sheet>
      <Sheet
        open={!!version}
        onClose={() => setVersion(null)}
        title={version ? `Version ${version.version}: ${version.title}` : ''}
        full
        footer={
          page.can_edit && version && version.version !== page.version ? (
            <Button
              title="Restore this version"
              variant="primary"
              full
              onPress={async () => {
                await act(() => api.post(`/pages/${page.id}/restore-version`, { version: version.version }), 'Version restored');
                setVersion(null);
                reload();
              }}
            />
          ) : undefined
        }
      >
        {version && <Markdown text={version.body} />}
      </Sheet>
      <Sheet open={settings} onClose={() => setSettings(false)} title="Page settings" full>
        <Field label="Status">
          <Select
            title="Status"
            value={page.status}
            onChange={async (v) => {
              await act(() => api.patch(`/pages/${page.id}`, { status: v }), v === 'approved' ? 'Page approved' : 'Marked as draft');
              reload();
            }}
            options={[
              { id: 'draft', label: 'Draft' },
              { id: 'approved', label: 'Approved' },
            ]}
          />
        </Field>
        <Field label="Review date" hint="The owner is reminded on Home when it is due.">
          <DateField
            value={page.review_date}
            label="Review date"
            onChange={async (v) => {
              await act(() => api.patch(`/pages/${page.id}`, { reviewDate: v }));
              reload();
            }}
          />
        </Field>
        <Field label="Inside" hint="Nest this page under another.">
          <Select
            title="Inside"
            value={page.parent_id ?? ''}
            onChange={async (v) => {
              await act(() => api.patch(`/pages/${page.id}`, { parentId: v || null }), 'Page moved');
              reload();
            }}
            options={[{ id: '', label: 'Top level' }, ...(allPages ?? []).filter((p) => !descendants.has(p.id)).map((p) => ({ id: p.id, label: p.title }))]}
          />
        </Field>
        <Field label="Owner">
          <PeopleField
            multiple={false}
            title="Owner"
            value={page.owner ? [page.owner.id] : []}
            people={people.filter((p) => p.role !== 'guest')}
            onChange={async (ids) => {
              if (!ids[0]) return;
              await act(() => api.patch(`/pages/${page.id}`, { ownerId: ids[0] }), 'Owner changed');
              reload();
            }}
          />
        </Field>
      </Sheet>
    </>
  );
}
