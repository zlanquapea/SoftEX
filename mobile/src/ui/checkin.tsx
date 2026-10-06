import { useState } from 'react';
import { api, type Project } from '../lib/api';
import { useApi } from '../lib/hooks';
import { Button, Field, Input, Select, Sheet, useAction } from './kit';

export function CheckinSheet({ open, onClose, onDone, projectId }: { open: boolean; onClose: () => void; onDone: () => void; projectId?: string }) {
  const act = useAction();
  const { data: projects } = useApi<Project[]>(open && !projectId ? '/projects' : null);
  const [form, setForm] = useState({ projectId: projectId ?? '', done: '', next: '', blockers: '' });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Daily check-in"
      eyebrow="Async update"
      full
      footer={
        <Button
          title="Share check-in"
          variant="primary"
          full
          disabled={!form.done && !form.next && !form.blockers}
          onPress={async () => {
            const ok = await act(() => api.post('/checkins', { ...form, projectId: form.projectId || null }), 'Check-in shared');
            if (ok) {
              setForm({ projectId: projectId ?? '', done: '', next: '', blockers: '' });
              onClose();
              onDone();
            }
          }}
        />
      }
    >
      {!projectId && (
        <Field label="Project">
          <Select title="Project" value={form.projectId} onChange={(v) => setForm({ ...form, projectId: v })} options={[{ id: '', label: 'General' }, ...(projects ?? []).map((p) => ({ id: p.id, label: p.name }))]} />
        </Field>
      )}
      <Field label="What did you get done?">
        <Input multiline value={form.done} onChangeText={(v) => setForm({ ...form, done: v })} />
      </Field>
      <Field label="What are you working on next?">
        <Input multiline value={form.next} onChangeText={(v) => setForm({ ...form, next: v })} />
      </Field>
      <Field label="Anything blocking you?" hint="Blockers notify the project owner.">
        <Input multiline value={form.blockers} onChangeText={(v) => setForm({ ...form, blockers: v })} />
      </Field>
    </Sheet>
  );
}

