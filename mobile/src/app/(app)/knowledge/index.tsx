import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { api, formWith, qs } from '@/lib/api';
import { pickDocuments, pickMedia } from '@/lib/files';
import { bytes, timeAgo } from '@/lib/format';
import { useApi, useReloadOnFocus } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useShell } from '@/lib/shell';
import { useTheme } from '@/lib/theme';
import { Icon } from '@/ui/Icon';
import { ActionSheet, Button, Card, Empty, ErrorState, Field, IconButton, Input, ListRow, Loading, Muted, Pill, Row, Screen, SearchBox, Select, Sheet, T, Tabs, Toggle, useAction } from '@/ui/kit';

export interface PageSummary {
  id: string;
  title: string;
  status: 'draft' | 'approved';
  project_id: string | null;
  project_name: string | null;
  review_date: string | null;
  needs_review: boolean;
  version: number;
  owner: { id: string; name: string; color: string } | null;
  updated_at: string;
  updated_by: { id: string; name: string } | null;
  excerpt: string;
  parent_id: string | null;
  icon: string | null;
  public: boolean;
}
interface FileSummary {
  id: string;
  name: string;
  label: string;
  external_url: string | null;
  version: number;
  mime: string | null;
  size: number | null;
  owner: { id: string; name: string; color: string } | null;
  updated_at: string;
}

export default function Knowledge() {
  const { c } = useTheme();
  const params = useLocalSearchParams<{ tab?: 'pages' | 'files' }>();
  const [tab, setTab] = useState<'pages' | 'files'>(params.tab === 'files' ? 'files' : 'pages');
  const { openCreate } = useShell();
  const { me } = useSession();
  const act = useAction();
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState<'all' | 'approved' | 'draft' | 'review'>('all');
  const [archived, setArchived] = useState(false);
  const pages = useApi<PageSummary[]>(tab === 'pages' ? `/pages${qs({ archived: archived ? 'true' : undefined })}` : null);
  const files = useApi<FileSummary[]>(tab === 'files' ? `/files${qs({ archived: archived ? 'true' : undefined })}` : null);
  useReloadOnFocus(() => (tab === 'pages' ? pages.reload() : files.reload()));
  const [linking, setLinking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [link, setLink] = useState({ name: '', url: '' });
  const guest = me!.role === 'guest';

  const pageIds = new Set((pages.data ?? []).map((p) => p.id));
  const childCount = (id: string) => (pages.data ?? []).filter((p) => p.parent_id === id).length;
  const narrowed = !!filter || status !== 'all';
  const pageList = (pages.data ?? []).filter(
    (p) =>
      (narrowed || !p.parent_id || !pageIds.has(p.parent_id)) &&
      (!filter || `${p.title} ${p.excerpt}`.toLowerCase().includes(filter.toLowerCase())) &&
      (status === 'all' || (status === 'review' ? p.needs_review : p.status === status)),
  );
  const fileList = (files.data ?? []).filter((f) => !filter || `${f.name} ${f.label}`.toLowerCase().includes(filter.toLowerCase()));
  const send = async (picked: { uri: string; name: string; type: string; file?: Blob }[]) => {
    for (const f of picked) await act(() => api.upload('/files', formWith({ file: f })), 'File uploaded');
    files.reload();
  };
  const current = tab === 'pages' ? pages : files;

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Knowledge',
          headerRight: () =>
            guest ? null : tab === 'files' ? (
              <Row gap={0}>
                <IconButton name="link" label="Link a file" onPress={() => setLinking(true)} />
                <IconButton name="upload" label="Upload" color={c.accentInk} onPress={() => setUploading(true)} />
              </Row>
            ) : (
              <IconButton name="plus" label="New page" color={c.accentInk} onPress={() => openCreate('page')} />
            ),
        }}
      />
      <Screen refreshing={current.refreshing} onRefresh={current.refresh}>
        <Muted size={14}>Policies, how-tos, decisions and files — with owners and review dates so they stay trustworthy.</Muted>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'pages', label: 'Pages' },
            { id: 'files', label: 'Files' },
          ]}
        />
        <SearchBox value={filter} onChangeText={setFilter} placeholder={`Filter ${tab}`} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, alignItems: 'center' }}>
          {tab === 'pages' && (
            <View style={{ width: 170 }}>
              <Select
                title="Status"
                value={status}
                onChange={setStatus}
                options={[
                  { id: 'all', label: 'All pages' },
                  { id: 'approved', label: 'Approved' },
                  { id: 'draft', label: 'Drafts' },
                  { id: 'review', label: 'Due for review' },
                ]}
              />
            </View>
          )}
          <View style={{ width: 150 }}>
            <Toggle label="Archived" value={archived} onChange={setArchived} />
          </View>
        </ScrollView>
        {current.error && !current.data ? (
          <ErrorState error={current.error} retry={current.reload} />
        ) : !current.data ? (
          <Loading inline />
        ) : tab === 'pages' ? (
          !pageList.length ? (
            <Empty icon="book" title="No pages yet">
              Capture how your team works: policies, onboarding guides, runbooks.
            </Empty>
          ) : (
            pageList.map((p) => (
              <Card key={p.id} onPress={() => router.push(`/knowledge/${p.id}`)} style={{ gap: 6 }}>
                <Row wrap gap={6}>
                  {p.icon ? <T size={18}>{p.icon}</T> : <Icon name="book" size={17} color={c.accentInk} />}
                  {p.public && <Icon name="globe" size={14} color={c.muted} />}
                  {p.status === 'approved' ? <Pill label="Approved" tone="green" /> : <Pill label="Draft" />}
                  {p.needs_review && <Pill label="Review due" tone="red" />}
                </Row>
                <T size={16} weight="display">
                  {p.title}
                </T>
                <Muted numberOfLines={2}>{p.excerpt || 'Empty page'}</Muted>
                <Muted size={12}>
                  {p.project_name ? `${p.project_name} · ` : ''}
                  {p.owner?.name} · updated {timeAgo(p.updated_at)}
                  {!narrowed && childCount(p.id) > 0 ? ` · ${childCount(p.id)} sub-page${childCount(p.id) === 1 ? '' : 's'}` : ''}
                </Muted>
              </Card>
            ))
          )
        ) : !fileList.length ? (
          <Empty icon="file" title="No files here" />
        ) : (
          <Card padded={false} style={{ paddingHorizontal: 14 }}>
            {fileList.map((f) => (
              <ListRow
                key={f.id}
                left={<Icon name={f.external_url ? 'link' : 'file'} size={18} color={c.ink2} />}
                title={f.name}
                subtitle={`${f.label ? `${f.label} · ` : ''}${f.owner?.name ?? ''} · ${f.external_url ? 'Link' : `${bytes(f.size)} · v${f.version}`} · ${timeAgo(f.updated_at)}`}
                chevron
                onPress={() => router.push(`/files/${f.id}`)}
              />
            ))}
          </Card>
        )}
      </Screen>
      <ActionSheet
        open={uploading}
        onClose={() => setUploading(false)}
        title="Upload"
        actions={[
          { label: 'Photo or video', icon: 'upload', onPress: () => act(async () => send(await pickMedia('library', true))) },
          { label: 'Take a photo', icon: 'eye', onPress: () => act(async () => send(await pickMedia('camera'))), hidden: Platform.OS === 'web' },
          { label: 'File', icon: 'file', onPress: () => act(async () => send(await pickDocuments(true))) },
        ]}
      />
      <Sheet
        open={linking}
        onClose={() => setLinking(false)}
        title="Link an external file"
        footer={
          <Button
            title="Add link"
            variant="primary"
            full
            disabled={!link.name.trim() || !/^https?:\/\//.test(link.url)}
            onPress={async () => {
              const ok = await act(() => api.post('/files/link', link), 'Link added');
              if (ok) {
                setLinking(false);
                setLink({ name: '', url: '' });
                files.reload();
              }
            }}
          />
        }
      >
        <Field label="Name">
          <Input value={link.name} onChangeText={(v) => setLink({ ...link, name: v })} />
        </Field>
        <Field label="URL">
          <Input value={link.url} onChangeText={(v) => setLink({ ...link, url: v })} placeholder="https://…" keyboardType="url" autoCapitalize="none" />
        </Field>
      </Sheet>
    </>
  );
}
