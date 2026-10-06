import { useState } from 'react';
import { View } from 'react-native';
import { api, type Project, type UserRef } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import { swatch } from '../lib/theme';
import { Button, Checkbox, Field, HealthPill, Input, Pill, Row, Segmented, Select, Sheet, T, useAction } from './kit';
import { DateField, PeopleField } from './pickers';

export type GoalStatus = 'on_track' | 'at_risk' | 'off_track' | 'done';
export interface KeyResult {
  id: string;
  title: string;
  kind: 'number' | 'tasks';
  start_value: number;
  target_value: number;
  current_value: number;
  unit: string;
  project: { id: string; name: string; color: string } | null;
  progress: number;
}
export interface Goal {
  id: string;
  parent_id: string | null;
  title: string;
  description: string;
  owner: UserRef | null;
  due_date: string | null;
  status: GoalStatus;
  progress: number;
  key_results: KeyResult[];
  projects: { id: string; name: string; color: string; health: string }[];
  can_edit: boolean;
  created_at: string;
  archived_at: string | null;
}

export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track', done: 'Achieved' };
export const pct = (p: number) => `${Math.round(p * 100)}%`;
export const GoalStatusPill = ({ status }: { status: GoalStatus }) => (status === 'done' ? <Pill label="Achieved" tone="green" /> : <HealthPill health={status} />);

export function GoalForm({ goal, goals, onClose, onSaved }: { goal?: Goal; goals: Goal[]; onClose: () => void; onSaved: (g: Goal) => void }) {
  const act = useAction();
  const { me } = useSession();
  const { data: projects } = useApi<Project[]>('/projects');
  const [title, setTitle] = useState(goal?.title ?? '');
  const [description, setDescription] = useState(goal?.description ?? '');
  const [ownerId, setOwnerId] = useState(goal?.owner?.id ?? me!.user.id);
  const [dueDate, setDueDate] = useState<string | null>(goal?.due_date ?? null);
  const [parentId, setParentId] = useState(goal?.parent_id ?? '');
  const [projectIds, setProjectIds] = useState<string[]>(goal?.projects.map((p) => p.id) ?? []);
  return (
    <Sheet
      open
      onClose={onClose}
      title={goal ? 'Edit goal' : 'New goal'}
      full
      footer={
        <Button
          title={goal ? 'Save' : 'Create goal'}
          variant="primary"
          full
          disabled={!title.trim()}
          onPress={async () => {
            const body = { title, description, ownerId, dueDate, parentId: parentId || null, projectIds };
            const saved = await act(() => (goal ? api.patch<Goal>(`/goals/${goal.id}`, body) : api.post<Goal>('/goals', body)), goal ? 'Goal saved' : 'Goal created');
            if (saved) onSaved(saved);
          }}
        />
      }
    >
      <Field label="Goal">
        <Input value={title} onChangeText={setTitle} maxLength={200} placeholder="Reach 5,000 active customers this year" autoFocus />
      </Field>
      <Field label="Why it matters">
        <Input multiline value={description} onChangeText={setDescription} maxLength={5000} />
      </Field>
      <Field label="Owner">
        <PeopleField multiple={false} title="Owner" value={[ownerId]} onChange={(ids) => ids[0] && setOwnerId(ids[0])} />
      </Field>
      <Field label="Due">
        <DateField value={dueDate} onChange={setDueDate} label="Due date" />
      </Field>
      <Field label="Part of" hint="Nest team goals under a company goal.">
        <Select title="Part of" value={parentId} onChange={setParentId} options={[{ id: '', label: 'Top-level goal' }, ...goals.filter((g) => g.id !== goal?.id).map((g) => ({ id: g.id, label: g.title }))]} />
      </Field>
      <Field label="Supporting projects">
        <View style={{ gap: 10 }}>
          {(projects ?? [])
            .filter((p) => !p.archived_at)
            .map((p) => (
              <Checkbox
                key={p.id}
                checked={projectIds.includes(p.id)}
                onChange={(v) => setProjectIds(v ? [...projectIds, p.id] : projectIds.filter((x) => x !== p.id))}
                label={
                  <Row gap={6}>
                    <View style={{ width: 9, height: 9, borderRadius: 3, backgroundColor: swatch(p.color) }} />
                    <T>{p.name}</T>
                  </Row>
                }
              />
            ))}
        </View>
      </Field>
    </Sheet>
  );
}

export function KeyResultForm({ goalId, projects, onClose, onSaved }: { goalId: string; projects: Project[]; onClose: () => void; onSaved: (g: Goal) => void }) {
  const act = useAction();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'number' | 'tasks'>('number');
  const [start, setStart] = useState('0');
  const [target, setTarget] = useState('100');
  const [unit, setUnit] = useState('');
  const [projectId, setProjectId] = useState('');
  return (
    <Sheet
      open
      onClose={onClose}
      title="New key result"
      footer={
        <Button
          title="Add"
          variant="primary"
          full
          disabled={!title.trim() || (kind === 'tasks' && !projectId)}
          onPress={async () => {
            const body = kind === 'tasks' ? { title, kind, projectId } : { title, kind, startValue: Number(start), targetValue: Number(target), unit };
            const g = await act(() => api.post<Goal>(`/goals/${goalId}/key-results`, body), 'Key result added');
            if (g) onSaved(g);
          }}
        />
      }
    >
      <Field label="Key result">
        <Input value={title} onChangeText={setTitle} maxLength={200} placeholder="Sign 40 new schools" autoFocus />
      </Field>
      <Segmented
        value={kind}
        onChange={setKind}
        options={[
          { id: 'number', label: 'A number' },
          { id: 'tasks', label: 'Project tasks done' },
        ]}
      />
      {kind === 'number' ? (
        <Row>
          <Field label="Start" style={{ flex: 1 }}>
            <Input value={start} onChangeText={setStart} keyboardType="decimal-pad" />
          </Field>
          <Field label="Target" style={{ flex: 1 }}>
            <Input value={target} onChangeText={setTarget} keyboardType="decimal-pad" />
          </Field>
          <Field label="Unit" style={{ flex: 1 }}>
            <Input value={unit} onChangeText={setUnit} maxLength={20} placeholder="%, US$" />
          </Field>
        </Row>
      ) : (
        <Field label="Project">
          <Select title="Project" value={projectId} placeholder="Choose a project…" onChange={setProjectId} options={projects.filter((p) => !p.archived_at).map((p) => ({ id: p.id, label: p.name }))} />
        </Field>
      )}
    </Sheet>
  );
}
