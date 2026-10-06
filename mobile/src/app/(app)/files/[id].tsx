import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { api, formWith, type Project } from '@/lib/api';
import { fileSource, isAudio, isImage, isVideo, openStoredFile, pickDocuments, pickMedia } from '@/lib/files';
import { bytes, dateTime, timeAgo } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useTheme } from '@/lib/theme';
import { Attachments } from '@/ui/chat';
import { Icon } from '@/ui/Icon';
import { ActionSheet, Avatar, Button, Card, ErrorState, Field, H1, Input, ListRow, Loading, Muted, Pill, Row, Screen, Section, Select, T, useAction } from '@/ui/kit';
import { openLink } from '@/ui/Markdown';

interface FileFull {
  id: string;
  name: string;
  label: string;
  external_url: string | null;
  project_id: string | null;
  version: number;
  mime: string | null;
  size: number | null;
  owner: { id: string; name: string; color: string } | null;
  updated_at: string;
  archived_at: string | null;
  versions: { version: number; mime: string; size: number; created_at: string; uploaded_by_name: string }[];
  project: { id: string; name: string } | null;
  channel: { id: string; name: string; kind: string } | null;
  task: { id: string; title: string } | null;
  can_edit: boolean;
}

export default function FileView() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const act = useAction();
  const { data: file, error, reload } = useApi<FileFull>(`/files/${id}`);
  const { data: projects } = useApi<Project[]>('/projects');
  const [label, setLabel] = useState('');
  const [uploading, setUploading] = useState(false);
  useEffect(() => setLabel(file?.label ?? ''), [file?.label]);
  if (error && !file) return <ErrorState error={error} retry={reload} />;
  if (!file) return <Loading />;
  const newVersion = async (picked: { uri: string; name: string; type: string; file?: Blob }[]) => {
    const f = picked[0];
    if (!f) return;
    await act(() => api.upload(`/files/${file.id}/versions`, formWith({ file: f })), 'New version uploaded');
    reload();
  };
  return (
    <>
      <Stack.Screen options={{ title: 'File' }} />
      <Screen>
        <Card style={{ gap: 12 }}>
          <Row gap={12} style={{ alignItems: 'flex-start' }}>
            <View style={{ width: 46, height: 46, borderRadius: 13, backgroundColor: c.blueSoft, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={file.external_url ? 'link' : 'file'} size={22} color={c.blueInk} />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <H1 style={{ fontSize: 20, lineHeight: 26 }}>{file.name}</H1>
              <Row gap={6} wrap>
                <Avatar user={file.owner} size="xs" />
                <Muted size={12}>
                  {file.owner?.name} · {file.external_url ? 'External link' : `version ${file.version} · ${bytes(file.size)}`} · updated {timeAgo(file.updated_at)}
                </Muted>
              </Row>
            </View>
          </Row>
          <Row wrap gap={6}>
            {file.project && <Pill label={file.project.name} icon="folder" />}
            {file.channel && <Pill label={file.channel.kind === 'dm' ? 'Direct message' : file.channel.name} icon="hash" />}
            {file.task && <Pill label={file.task.title} icon="task" />}
            {file.archived_at && <Pill label="Archived" />}
          </Row>
          {file.external_url ? (
            <Button variant="primary" icon="link" title="Open link" full onPress={() => openLink(file.external_url!)} />
          ) : (
            <Button variant="primary" icon="download" title={Platform.OS === 'web' ? 'Download' : 'Open or share'} full onPress={() => act(() => openStoredFile(file.id, file.name))} />
          )}
          {!file.external_url && isImage(file.mime, file.name) && <Image source={fileSource(file.id)} style={{ width: '100%', aspectRatio: 4 / 3, borderRadius: 12, backgroundColor: c.line2 }} contentFit="contain" accessibilityLabel={file.name} />}
          {!file.external_url && (isAudio(file.mime, file.name) || isVideo(file.mime, file.name)) && <Attachments files={[{ id: file.id, name: file.name, mime: file.mime ?? '', size: file.size ?? 0 }]} />}
        </Card>
        {(file.project || file.channel || file.task) && (
          <Card padded={false} style={{ paddingHorizontal: 14 }}>
            {file.project && <ListRow left={<Icon name="folder" size={17} color={c.ink2} />} title={file.project.name} chevron onPress={() => router.push(`/projects/${file.project!.id}?tab=resources`)} />}
            {file.channel && <ListRow left={<Icon name="hash" size={17} color={c.ink2} />} title={file.channel.kind === 'dm' ? 'Direct message' : file.channel.name} chevron onPress={() => router.push(`/channels/${file.channel!.id}`)} />}
            {file.task && <ListRow left={<Icon name="task" size={17} color={c.ink2} />} title={file.task.title} chevron onPress={() => router.push(`/tasks/${file.task!.id}`)} />}
          </Card>
        )}
        {!file.external_url && (
          <Section title="Versions" action={file.can_edit ? <Button small icon="upload" title="New version" onPress={() => setUploading(true)} /> : undefined}>
            {file.versions.map((v) => (
              <ListRow key={v.version} title={`Version ${v.version}`} subtitle={`${bytes(v.size)} · ${v.uploaded_by_name} · ${dateTime(v.created_at)}`} />
            ))}
          </Section>
        )}
        {file.can_edit && (
          <Section title="File settings">
            <View style={{ gap: 12 }}>
              <Field label="Label">
                <Input
                  value={label}
                  onChangeText={setLabel}
                  placeholder="e.g. Final, Contract, Brand"
                  onBlur={async () => {
                    if (label === file.label) return;
                    await act(() => api.patch(`/files/${file.id}`, { label }), 'Label saved');
                    reload();
                  }}
                />
              </Field>
              <Field label="Project">
                <Select
                  title="Project"
                  value={file.project_id ?? ''}
                  onChange={async (v) => {
                    await act(() => api.patch(`/files/${file.id}`, { projectId: v || null }), 'File moved');
                    reload();
                  }}
                  options={[{ id: '', label: 'No project' }, ...(projects ?? []).map((p) => ({ id: p.id, label: p.name }))]}
                />
              </Field>
              <Button
                small
                variant="danger"
                title={file.archived_at ? 'Restore file' : 'Archive file'}
                onPress={async () => {
                  await act(() => api.post(`/files/${file.id}/archive`, { archived: !file.archived_at }), file.archived_at ? 'File restored' : 'File archived');
                  if (file.archived_at) reload();
                  else router.back();
                }}
              />
            </View>
          </Section>
        )}
      </Screen>
      <ActionSheet
        open={uploading}
        onClose={() => setUploading(false)}
        title="Upload a new version"
        actions={[
          { label: 'Photo or video', icon: 'upload', onPress: () => act(async () => newVersion(await pickMedia('library'))) },
          { label: 'File', icon: 'file', onPress: () => act(async () => newVersion(await pickDocuments())) },
        ]}
      />
    </>
  );
}
