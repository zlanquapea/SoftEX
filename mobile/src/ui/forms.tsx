import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { api, type UserRef } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useTheme } from '../lib/theme';
import { Icon } from './Icon';
import { Button, Card, Checkbox, confirm, Empty, ErrorState, Field, IconButton, Input, Loading, Muted, Pill, Row, Select, Sheet, T, Toggle, useAction, useToast } from './kit';
import { DateField, PeopleField } from './pickers';
import { useProjectFields } from './work';

export type QuestionType = 'short' | 'long' | 'email' | 'number' | 'date' | 'select';
export interface Question {
  id: string;
  label: string;
  type: QuestionType;
  required: boolean;
  options: string[];
  maps?: string | null;
}
export interface IntakeForm {
  id: string;
  project_id: string;
  title: string;
  description: string;
  questions: Question[];
  public: boolean;
  public_url: string | null;
  owner: UserRef | null;
  closed: boolean;
  responses: number;
  created_at: string;
  project?: { id: string; name: string } | null;
  can_manage?: boolean;
}

const TYPE_LABEL: Record<QuestionType, string> = { short: 'Short answer', long: 'Paragraph', email: 'Email', number: 'Number', date: 'Date', select: 'Choice' };
const MAPS_LABEL: Record<string, string> = { title: 'Task title', description: 'Task description', due_date: 'Due date', priority: 'Priority' };
const newQuestion = (n: number, patch: Partial<Question> = {}): Question => ({ id: `q${Date.now().toString(36)}${n}`, label: '', type: 'short', required: false, options: [], maps: null, ...patch });

/** A project's intake forms: requests from anyone become tasks. */
export function ProjectForms({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { c } = useTheme();
  const toast = useToast();
  const { data, error, reload } = useApi<IntakeForm[]>(`/projects/${projectId}/forms`);
  const [editing, setEditing] = useState<IntakeForm | 'new' | null>(null);
  if (error && !data) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading inline />;
  return (
    <View style={{ gap: 12 }}>
      <Muted>Collect requests with a form. Every response becomes a task here, assigned to the form’s owner.</Muted>
      {canManage && <Button variant="primary" icon="plus" title="New form" onPress={() => setEditing('new')} />}
      {!data.length && (
        <Empty icon="form" title="No forms yet">
          {canManage ? 'Create one to take in bug reports, design requests or IT tickets.' : 'Project leads can create forms.'}
        </Empty>
      )}
      {data.map((f) => (
        <Card key={f.id} style={{ gap: 8 }}>
          <Row>
            <Icon name="form" size={18} color={c.ink2} />
            <T weight="bold" style={{ flex: 1 }}>
              {f.title}
            </T>
            {f.closed ? <Pill label="Closed" /> : f.public ? <Pill label="Public link" tone="green" /> : <Pill label="Members only" />}
          </Row>
          <Muted size={12}>
            {f.questions.length} question{f.questions.length === 1 ? '' : 's'} · {f.responses} response{f.responses === 1 ? '' : 's'}
            {f.owner ? ` · goes to ${f.owner.name}` : ''}
          </Muted>
          <Row wrap>
            <Button small title="Open form" onPress={() => router.push(`/forms/${f.id}`)} />
            {f.public_url && (
              <Button
                small
                icon="link"
                title="Copy public link"
                onPress={async () => {
                  await Clipboard.setStringAsync(f.public_url!);
                  toast('Link copied');
                }}
              />
            )}
            {canManage && <Button small title="Edit" onPress={() => setEditing(f)} />}
          </Row>
        </Card>
      ))}
      {editing && (
        <FormBuilder
          projectId={projectId}
          form={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </View>
  );
}

function FormBuilder({ projectId, form, onClose, onSaved }: { projectId: string; form: IntakeForm | null; onClose: () => void; onSaved: () => void }) {
  const { c } = useTheme();
  const act = useAction();
  const { data: fields } = useProjectFields(projectId);
  const [title, setTitle] = useState(form?.title ?? '');
  const [description, setDescription] = useState(form?.description ?? '');
  const [ownerId, setOwnerId] = useState(form?.owner?.id ?? '');
  const [isPublic, setPublic] = useState(form?.public ?? false);
  const [closed, setClosed] = useState(form?.closed ?? false);
  const [questions, setQuestions] = useState<Question[]>(
    form?.questions ?? [newQuestion(0, { label: 'What do you need?', required: true, maps: 'title' }), newQuestion(1, { label: 'Details', type: 'long', maps: 'description' })],
  );
  const set = (i: number, patch: Partial<Question>) => setQuestions((qs) => qs.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const mapOptions = [{ id: '', label: 'Description only' }, ...Object.entries(MAPS_LABEL).map(([id, label]) => ({ id, label })), ...(fields ?? []).map((f) => ({ id: f.id, label: `Field: ${f.name}` }))];
  const save = async () => {
    const body = { title, description, ownerId: ownerId || null, public: isPublic, questions: questions.map((q) => ({ ...q, options: q.type === 'select' ? q.options.map((o) => o.trim()).filter(Boolean) : [] })) };
    const ok = form ? await act(() => api.patch(`/forms/${form.id}`, { ...body, closed }), 'Form saved') : await act(() => api.post(`/projects/${projectId}/forms`, body), 'Form created');
    if (ok) onSaved();
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={form ? 'Edit form' : 'New form'}
      eyebrow="Intake form"
      full
      footer={<Button title="Save form" variant="primary" full onPress={save} disabled={!title.trim() || questions.some((q) => !q.label.trim())} />}
    >
      <Field label="Title">
        <Input value={title} onChangeText={setTitle} maxLength={200} placeholder="Design request" />
      </Field>
      <Field label="Introduction" hint="Shown above the questions.">
        <Input multiline value={description} onChangeText={setDescription} maxLength={5000} />
      </Field>
      <Field label="New tasks go to">
        <PeopleField multiple={false} title="New tasks go to" allowNone="Nobody (unassigned)" placeholder="Nobody (unassigned)" value={ownerId ? [ownerId] : []} onChange={(ids) => setOwnerId(ids[0] ?? '')} />
      </Field>
      <Toggle label="Anyone with the link can respond" hint="No sign-in needed" value={isPublic} onChange={setPublic} />
      {form && <Toggle label="Closed" hint="Stop taking responses" value={closed} onChange={setClosed} />}
      <T weight="display" size={16}>
        Questions
      </T>
      {questions.map((q, i) => (
        <Card key={q.id} style={{ gap: 8 }}>
          <Row>
            <Input style={{ flex: 1 }} value={q.label} onChangeText={(v) => set(i, { label: v })} placeholder={`Question ${i + 1}`} accessibilityLabel={`Question ${i + 1}`} maxLength={200} />
            {questions.length > 1 && <IconButton name="trash" label="Remove question" color={c.red} onPress={() => setQuestions((qs) => qs.filter((_, j) => j !== i))} />}
          </Row>
          <Select title="Answer type" value={q.type} onChange={(v) => set(i, { type: v })} options={(Object.keys(TYPE_LABEL) as QuestionType[]).map((t) => ({ id: t, label: TYPE_LABEL[t] }))} />
          {q.type === 'select' && <Input value={q.options.join(', ')} onChangeText={(v) => set(i, { options: v.split(',').map((o) => o.trimStart()) })} placeholder="Choices, separated by commas" accessibilityLabel="Choices" />}
          <Checkbox checked={q.required} onChange={(v) => set(i, { required: v })} label="Required" />
          <Field label="Fills in">
            <Select title="Fills in" value={q.maps ?? ''} onChange={(v) => set(i, { maps: v || null })} options={mapOptions} />
          </Field>
        </Card>
      ))}
      <Button small icon="plus" title="Add question" disabled={questions.length >= 40} onPress={() => setQuestions((qs) => [...qs, newQuestion(qs.length)])} />
      {form?.public && (
        <Button
          small
          title="New public link"
          onPress={async () => {
            if (!(await confirm('Make a new public link?', 'The old one stops working.', 'New link', false))) return;
            if (await act(() => api.patch(`/forms/${form.id}`, { newLink: true }), 'New link created')) onSaved();
          }}
        />
      )}
      {form && (
        <Button
          small
          variant="danger"
          title="Delete form"
          onPress={async () => {
            if (!(await confirm('Delete this form?', 'Tasks it created stay.', 'Delete'))) return;
            if (await act(() => api.del(`/forms/${form.id}`), 'Form deleted')) onSaved();
          }}
        />
      )}
    </Sheet>
  );
}

/** The questions, as a fillable form. */
export function FormFields({ questions, answers, onChange }: { questions: Question[]; answers: Record<string, unknown>; onChange: (a: Record<string, unknown>) => void }) {
  const set = (id: string, v: unknown) => onChange({ ...answers, [id]: v });
  return (
    <>
      {questions.map((q) => {
        const value = answers[q.id] == null ? '' : String(answers[q.id]);
        return (
          <Field key={q.id} label={`${q.label}${q.required ? ' *' : ''}`}>
            {q.type === 'select' ? (
              <Select title={q.label} value={value} placeholder="Choose…" onChange={(v) => set(q.id, v)} options={q.options.map((o) => ({ id: o, label: o }))} />
            ) : q.type === 'date' ? (
              <DateField value={value || null} onChange={(v) => set(q.id, v ?? '')} label={q.label} />
            ) : (
              <Input
                value={value}
                multiline={q.type === 'long'}
                maxLength={q.type === 'short' ? 500 : 10000}
                keyboardType={q.type === 'email' ? 'email-address' : q.type === 'number' ? 'decimal-pad' : 'default'}
                autoCapitalize={q.type === 'email' ? 'none' : 'sentences'}
                onChangeText={(v) => set(q.id, q.type === 'number' ? (v === '' ? '' : Number(v)) : v)}
              />
            )}
          </Field>
        );
      })}
    </>
  );
}

export const cleanAnswers = (answers: Record<string, unknown>) => Object.fromEntries(Object.entries(answers).filter(([, v]) => v !== '' && v !== undefined && !(typeof v === 'number' && Number.isNaN(v))));
