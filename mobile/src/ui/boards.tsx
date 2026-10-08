import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { api, type Project } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useApi, useReloadOnFocus } from '../lib/hooks';
import { swatch, useTheme } from '../lib/theme';
import { Icon } from './Icon';
import { Button, Card, Empty, ErrorState, Field, Input, Loading, Muted, Row, Select, Sheet, T, useAction } from './kit';

export interface Board {
  id: string;
  title: string;
  project: { id: string; name: string; color: string } | null;
  owner: { id: string; name: string } | null;
  can_edit: boolean;
  can_delete: boolean;
  updated_at: string;
  archived_at: string | null;
}

export function NewBoardSheet({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId?: string }) {
  const act = useAction();
  const { data: projects } = useApi<Project[]>(projectId || !open ? null : '/projects');
  const [title, setTitle] = useState('');
  const [project, setProject] = useState(projectId ?? '');
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New whiteboard"
      footer={
        <Button
          title="Create"
          variant="primary"
          full
          disabled={!title.trim()}
          onPress={async () => {
            const b = await act(() => api.post<Board>('/boards', { title, projectId: project || null }));
            if (b) {
              onClose();
              setTitle('');
              router.push(`/boards/${b.id}`);
            }
          }}
        />
      }
    >
      <Field label="Name">
        <Input value={title} onChangeText={setTitle} maxLength={120} placeholder="Q4 planning workshop" autoFocus />
      </Field>
      {!projectId && (
        <Field label="Project" hint="Project whiteboards are shared with the project; others with everyone in the workspace.">
          <Select
            title="Project"
            value={project}
            onChange={setProject}
            options={[{ id: '', label: 'No project (whole workspace)' }, ...(projects ?? []).filter((p) => !p.archived_at).map((p) => ({ id: p.id, label: p.name }))]}
          />
        </Field>
      )}
    </Sheet>
  );
}

export function BoardsList({ projectId, archived = false }: { projectId?: string; archived?: boolean }) {
  const { c } = useTheme();
  const { data, error, reload } = useApi<Board[]>(`/boards?archived=${archived}${projectId ? `&projectId=${projectId}` : ''}`);
  useReloadOnFocus(reload);
  if (error && !data) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading inline />;
  if (!data.length)
    return (
      <Empty icon="whiteboard" title={archived ? 'No archived whiteboards' : 'No whiteboards yet'}>
        {archived ? undefined : 'Brainstorm with sticky notes, sketch a process, or plan a workshop together — everyone edits at once.'}
      </Empty>
    );
  return (
    <View style={{ gap: 10 }}>
      {data.map((b) => (
        <Card key={b.id} onPress={() => router.push(`/boards/${b.id}`)} style={{ gap: 6 }}>
          <Row>
            <Icon name="whiteboard" size={18} color={c.accentInk} />
            <T weight="bold" style={{ flex: 1 }} numberOfLines={1}>
              {b.title}
            </T>
          </Row>
          <Row gap={6}>
            {b.project && <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: swatch(b.project.color) }} />}
            <Muted size={12} numberOfLines={1}>
              {b.project ? `${b.project.name} · ` : ''}
              {b.owner?.name} · updated {timeAgo(b.updated_at)}
            </Muted>
          </Row>
        </Card>
      ))}
    </View>
  );
}

/** A project's whiteboards tab. */
export function ProjectBoards({ projectId }: { projectId: string }) {
  const [creating, setCreating] = useState(false);
  return (
    <View style={{ gap: 12 }}>
      <Muted>Whiteboards shared with this project.</Muted>
      <Button small variant="primary" icon="plus" title="New whiteboard" onPress={() => setCreating(true)} />
      <BoardsList projectId={projectId} />
      <NewBoardSheet open={creating} onClose={() => setCreating(false)} projectId={projectId} />
    </View>
  );
}
