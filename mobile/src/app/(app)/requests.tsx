import { Stack } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useApi, useReloadOnFocus } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import { Avatar, Button, Card, Empty, ErrorState, Field, IconButton, Input, Loading, Muted, Pill, Row, Screen, Select, Sheet, T, Tabs, useAction } from '@/ui/kit';
import { PeopleField } from '@/ui/pickers';

interface Request {
  id: string;
  kind: string;
  title: string;
  details: string;
  requester_id: string;
  requester_name: string;
  requester_color: string;
  approver_id: string;
  approver_name: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  resolution_note: string;
  decided_at: string | null;
  created_at: string;
}
const KIND_LABEL: Record<string, string> = { access: 'Access', purchase: 'Purchase', leave: 'Leave handoff', support: 'Internal support', other: 'Other' };
const STATUS_TONE = { pending: 'amber', approved: 'green', rejected: 'red', cancelled: 'neutral' } as const;

export default function Requests() {
  const { c } = useTheme();
  const { me, people } = useSession();
  const act = useAction();
  const [tab, setTab] = useState<'inbox' | 'mine'>('inbox');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ kind: 'purchase', title: '', details: '', approverId: '' });
  const [note, setNote] = useState<Record<string, string>>({});
  const { data, error, reload, refresh, refreshing } = useApi<Request[]>('/requests');
  useReloadOnFocus(reload);
  const list = (data ?? []).filter((r) => (tab === 'inbox' ? r.approver_id === me!.user.id : r.requester_id === me!.user.id));
  const pending = (data ?? []).filter((r) => r.approver_id === me!.user.id && r.status === 'pending').length;
  const decide = async (r: Request, status: 'approved' | 'rejected' | 'cancelled') => {
    await act(() => api.post(`/requests/${r.id}/decide`, { status, note: note[r.id] ?? '' }), `Request ${status}`);
    reload();
  };
  return (
    <>
      <Stack.Screen options={{ title: 'Requests', headerRight: () => <IconButton name="plus" label="New request" color={c.accentInk} onPress={() => setCreating(true)} /> }} />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        <Muted size={14}>Lightweight approvals for access, purchases, leave handoffs and internal support.</Muted>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'inbox', label: 'To approve', count: pending },
            { id: 'mine', label: 'My requests' },
          ]}
        />
        {error && !data ? (
          <ErrorState error={error} retry={reload} />
        ) : !data ? (
          <Loading inline />
        ) : !list.length ? (
          <Empty icon="inboxCheck" title={tab === 'inbox' ? 'Nothing waiting for you' : 'You have not made any requests'} />
        ) : (
          list.map((r) => (
            <Card key={r.id} style={{ gap: 8 }}>
              <Row style={{ alignItems: 'flex-start' }}>
                <Avatar user={{ id: r.requester_id, name: r.requester_name, color: r.requester_color }} size="sm" />
                <View style={{ flex: 1, gap: 4 }}>
                  <T weight="bold">{r.title}</T>
                  <Row wrap gap={6}>
                    <Pill label={KIND_LABEL[r.kind] ?? r.kind} />
                    <Pill label={r.status} tone={STATUS_TONE[r.status]} />
                    <Muted size={12}>{timeAgo(r.created_at)}</Muted>
                  </Row>
                </View>
              </Row>
              <Muted size={12}>
                {r.requester_name} → {r.approver_name}
              </Muted>
              {!!r.details && <T size={14}>{r.details}</T>}
              {!!r.resolution_note && (
                <View style={{ padding: 10, borderRadius: 10, backgroundColor: c.surface2 }}>
                  <T size={14}>
                    <T size={14} weight="bold">
                      {r.approver_name}:
                    </T>{' '}
                    {r.resolution_note}
                  </T>
                </View>
              )}
              {r.status === 'pending' && r.approver_id === me!.user.id && (
                <View style={{ gap: 8 }}>
                  <Input placeholder="Optional note" value={note[r.id] ?? ''} onChangeText={(v) => setNote({ ...note, [r.id]: v })} accessibilityLabel="Note" />
                  <Row>
                    <Button title="Decline" onPress={() => decide(r, 'rejected')} style={{ flex: 1 }} full />
                    <Button title="Approve" variant="primary" onPress={() => decide(r, 'approved')} style={{ flex: 1 }} full />
                  </Row>
                </View>
              )}
              {r.status === 'pending' && r.requester_id === me!.user.id && <Button small title="Cancel request" onPress={() => decide(r, 'cancelled')} />}
            </Card>
          ))
        )}
      </Screen>
      <Sheet
        open={creating}
        onClose={() => setCreating(false)}
        title="New request"
        full
        footer={
          <Button
            title="Send request"
            variant="primary"
            full
            disabled={!form.title.trim() || !form.approverId}
            onPress={async () => {
              const ok = await act(() => api.post('/requests', form), 'Request sent');
              if (ok) {
                setCreating(false);
                setForm({ kind: 'purchase', title: '', details: '', approverId: '' });
                setTab('mine');
                reload();
              }
            }}
          />
        }
      >
        <Field label="Type">
          <Select title="Type" value={form.kind} onChange={(v) => setForm({ ...form, kind: v })} options={Object.entries(KIND_LABEL).map(([id, label]) => ({ id, label }))} />
        </Field>
        <Field label="Approver">
          <PeopleField
            multiple={false}
            title="Approver"
            placeholder="Choose…"
            value={form.approverId ? [form.approverId] : []}
            onChange={(ids) => setForm({ ...form, approverId: ids[0] ?? '' })}
            people={people.filter((p) => p.id !== me!.user.id && p.role !== 'guest')}
          />
        </Field>
        <Field label="What do you need?">
          <Input value={form.title} onChangeText={(v) => setForm({ ...form, title: v })} placeholder="e.g. Figma licence for the design contractor" />
        </Field>
        <Field label="Details">
          <Input multiline value={form.details} onChangeText={(v) => setForm({ ...form, details: v })} placeholder="Cost, dates, justification, links to the system of record…" />
        </Field>
      </Sheet>
    </>
  );
}
