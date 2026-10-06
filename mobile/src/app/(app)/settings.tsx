import * as Clipboard from 'expo-clipboard';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api, type Me } from '@/lib/api';
import { shareApiDownload } from '@/lib/files';
import { dateLabel, timeAgo } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { pushState, registerPush, unregisterPush, type PushState } from '@/lib/push';
import { useSession } from '@/lib/session';
import { useTheme, type ThemeChoice } from '@/lib/theme';
import { MfaSetupBody } from '@/screens/auth';
import { Icon } from '@/ui/Icon';
import {
  Button,
  Card,
  Checkbox,
  confirm,
  Field,
  Input,
  LinkText,
  ListRow,
  Loading,
  Muted,
  PasswordInput,
  Pill,
  ProgressBar,
  Row,
  Screen,
  SearchBox,
  Section,
  Select,
  Sheet,
  T,
  Tabs,
  Toggle,
  useAction,
  useToast,
} from '@/ui/kit';
import { openLink } from '@/ui/Markdown';
import { UpgradeNotice, usePlan } from '@/ui/plan';

type Tab = 'profile' | 'notifications' | 'security' | 'api' | 'onboarding';

export default function Settings() {
  const params = useLocalSearchParams<{ tab?: Tab }>();
  const [tab, setTab] = useState<Tab>(params.tab ?? 'profile');
  const { has } = usePlan();
  return (
    <>
      <Stack.Screen options={{ title: 'Settings' }} />
      <Screen>
        <Muted size={14}>Your profile, notifications and account security.</Muted>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'profile', label: 'Profile' },
            { id: 'notifications', label: 'Notifications & focus' },
            { id: 'security', label: 'Security' },
            { id: 'api', label: 'API tokens' },
            { id: 'onboarding', label: 'Onboarding' },
          ]}
        />
        {tab === 'profile' && (
          <>
            <Appearance />
            <Profile />
          </>
        )}
        {tab === 'notifications' && <Notifications />}
        {tab === 'security' && <Security />}
        {tab === 'api' && (has('api') ? <ApiTokens /> : <UpgradeNotice feature="api" />)}
        {tab === 'onboarding' && <Onboarding />}
      </Screen>
    </>
  );
}

function Appearance() {
  const { c, choice, setChoice } = useTheme();
  const options: { id: ThemeChoice; label: string; hint: string; icon: string }[] = [
    { id: 'system', label: 'System', hint: 'Match this phone', icon: 'monitor' },
    { id: 'light', label: 'Light', hint: 'Cream and terracotta', icon: 'sun' },
    { id: 'dark', label: 'Dark', hint: 'Easier at night', icon: 'moon' },
  ];
  return (
    <Section title="Appearance">
      <Row gap={8} accessibilityRole="radiogroup">
        {options.map((o) => {
          const on = choice === o.id;
          return (
            <Pressable
              key={o.id}
              onPress={() => setChoice(o.id)}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              style={{ flex: 1, gap: 4, padding: 10, borderRadius: 12, borderWidth: 2, borderColor: on ? c.accent : c.line, backgroundColor: c.surface }}
            >
              <Icon name={o.icon} size={18} color={on ? c.accentInk : c.ink2} />
              <T size={14} weight="bold">
                {o.label}
              </T>
              <Muted size={11}>{o.hint}</Muted>
            </Pressable>
          );
        })}
      </Row>
      <Muted size={12} style={{ marginTop: 8 }}>
        Saved on this phone.
      </Muted>
    </Section>
  );
}

const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Africa/Monrovia', 'Africa/Lagos', 'Africa/Nairobi', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Asia/Kolkata', 'Asia/Tokyo'];
  }
})();

function TimeZoneField({ value, onChange }: { value: string; onChange: (tz: string) => void }) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const list = useMemo(() => ZONES.filter((z) => !q || z.toLowerCase().includes(q.toLowerCase().replace(/\s+/g, '_'))).slice(0, 80), [q]);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel="Time zone" style={{ minHeight: 46, justifyContent: 'center', borderWidth: 1, borderColor: c.lineStrong, borderRadius: 11, paddingHorizontal: 13, backgroundColor: c.surface }}>
        <T>{value}</T>
      </Pressable>
      <Sheet open={open} onClose={() => setOpen(false)} title="Time zone" full>
        <SearchBox value={q} onChangeText={setQ} placeholder="Search cities" autoFocus />
        <View>
          {list.map((z) => (
            <ListRow
              key={z}
              title={z.replace(/_/g, ' ')}
              right={z === value ? <Icon name="check" size={18} color={c.accent} /> : undefined}
              onPress={() => {
                onChange(z);
                setOpen(false);
              }}
            />
          ))}
        </View>
      </Sheet>
    </>
  );
}

function Profile() {
  const { me, setMe, reloadPeople } = useSession();
  const act = useAction();
  const u = me!.user;
  const [form, setForm] = useState({ name: u.name, title: u.title, timezone: u.timezone, working_hours: u.working_hours, status_text: u.status_text, expertise: u.expertise.join(', ') });
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <Section title="Profile">
      <View style={{ gap: 12 }}>
        <Field label="Name">
          <Input value={form.name} onChangeText={(v) => setForm({ ...form, name: v })} />
        </Field>
        <Field label="Title">
          <Input value={form.title} onChangeText={(v) => setForm({ ...form, title: v })} placeholder="e.g. Product designer" />
        </Field>
        <Field label="Time zone">
          <TimeZoneField value={form.timezone} onChange={(tz) => setForm({ ...form, timezone: tz })} />
        </Field>
        {form.timezone !== deviceZone && (
          <Row gap={4} wrap>
            <Muted>This phone is in {deviceZone}.</Muted>
            <LinkText onPress={() => setForm({ ...form, timezone: deviceZone })}>Use it</LinkText>
          </Row>
        )}
        <Field label="Working hours">
          <Input value={form.working_hours} onChangeText={(v) => setForm({ ...form, working_hours: v })} placeholder="09:00-17:00" />
        </Field>
        <Field label="Status message">
          <Input value={form.status_text} onChangeText={(v) => setForm({ ...form, status_text: v })} placeholder="e.g. In workshops until 2pm" maxLength={100} />
        </Field>
        <Field label="Expertise" hint="Comma separated. Helps colleagues find you in the directory.">
          <Input value={form.expertise} onChangeText={(v) => setForm({ ...form, expertise: v })} placeholder="Research, Figma, Accessibility" />
        </Field>
        <Button
          variant="primary"
          title="Save profile"
          disabled={!form.name.trim()}
          onPress={async () => {
            const updated = await act(
              () =>
                api.patch<Me>('/me', {
                  ...form,
                  expertise: form.expertise
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                }),
              'Profile saved',
            );
            if (updated) {
              setMe(updated);
              reloadPeople();
            }
          }}
        />
      </View>
    </Section>
  );
}

const TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

function Notifications() {
  const { me, setMe } = useSession();
  const act = useAction();
  const [quiet, setQuiet] = useState({ start: me!.user.quiet_start ?? '', end: me!.user.quiet_end ?? '' });
  const focusActive = me!.user.focus_until && new Date(me!.user.focus_until) > new Date();
  const setFocus = async (minutes: number | null) => {
    const updated = await act(
      () => api.patch<Me>('/me', minutes ? { status: 'focus', focus_until: new Date(Date.now() + minutes * 60_000).toISOString() } : { status: 'available', focus_until: null }),
      minutes ? `Focus time on for ${minutes >= 60 ? `${minutes / 60} hour${minutes > 60 ? 's' : ''}` : `${minutes} minutes`}` : 'Focus time ended',
    );
    if (updated) setMe(updated);
  };
  const timeOptions = [{ id: '', label: 'Not set' }, ...TIMES.map((t) => ({ id: t, label: t }))];
  return (
    <>
      <PhoneNotifications />
      <Section title="Focus time">
        <Muted style={{ marginBottom: 8 }}>During focus time, notifications are collected in your Inbox without interrupting you. Urgent messages still come through.</Muted>
        {focusActive ? (
          <Row wrap>
            <T weight="bold">Focusing until {new Date(me!.user.focus_until!).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.</T>
            <LinkText onPress={() => setFocus(null)}>End now</LinkText>
          </Row>
        ) : (
          <Row wrap>
            {[30, 60, 120, 240].map((m) => (
              <Button key={m} small icon="moon" title={m >= 60 ? `${m / 60} h` : `${m} min`} onPress={() => setFocus(m)} />
            ))}
          </Row>
        )}
      </Section>
      <Section title="Quiet hours">
        <View style={{ gap: 10 }}>
          <Muted>A daily window, in your time zone ({me!.user.timezone}), when non-urgent notifications stay silent.</Muted>
          <Row>
            <Field label="From" style={{ flex: 1 }}>
              <Select title="From" value={quiet.start} onChange={(v) => setQuiet({ ...quiet, start: v })} options={timeOptions} />
            </Field>
            <Field label="Until" style={{ flex: 1 }}>
              <Select title="Until" value={quiet.end} onChange={(v) => setQuiet({ ...quiet, end: v })} options={timeOptions} />
            </Field>
          </Row>
          <Row>
            {(quiet.start || quiet.end) && <Button title="Clear" onPress={() => setQuiet({ start: '', end: '' })} />}
            <Button
              variant="primary"
              title="Save quiet hours"
              onPress={async () => {
                const updated = await act(() => api.patch<Me>('/me', { quiet_start: quiet.start || null, quiet_end: quiet.end || null }), 'Quiet hours saved');
                if (updated) setMe(updated);
              }}
            />
          </Row>
        </View>
      </Section>
      <Section title="Email">
        <Toggle
          label="Morning digest"
          hint="At 8am in your time zone, if you have unread notifications."
          value={me!.user.email_digest}
          onChange={async (v) => {
            const updated = await act(() => api.patch<Me>('/me', { email_digest: v }), 'Email preference saved');
            if (updated) setMe(updated);
          }}
        />
        <Toggle
          label="Urgent messages while I am away"
          hint="Only when you are not connected to Küü."
          value={me!.user.email_urgent}
          onChange={async (v) => {
            const updated = await act(() => api.patch<Me>('/me', { email_urgent: v }), 'Email preference saved');
            if (updated) setMe(updated);
          }}
        />
        <Muted size={12}>Invitations, password resets and meeting invitations are always emailed.</Muted>
      </Section>
    </>
  );
}

/** Push notifications on this phone. */
function PhoneNotifications() {
  const { c } = useTheme();
  const act = useAction();
  const [state, setState] = useState<PushState | null>(null);
  useEffect(() => {
    pushState().then(setState);
  }, []);
  return (
    <Section title="Notifications on this phone">
      <View style={{ gap: 10 }}>
        <Muted>Get mentions, assignments and urgent messages on this phone when Küü is closed. They follow your quiet hours and focus time, except urgent messages.</Muted>
        {state === null && <Loading inline />}
        {state === 'on' && (
          <Row wrap>
            <Row gap={4}>
              <Icon name="check" size={16} color={c.green} />
              <T>On for this phone.</T>
            </Row>
            <Button small title="Send a test" onPress={() => act(() => api.post('/me/push/test'), 'Test notification sent')} />
            <Button
              small
              variant="danger"
              title="Turn off"
              onPress={async () => {
                await act(unregisterPush, 'Notifications are off for this phone');
                setState(await pushState());
              }}
            />
          </Row>
        )}
        {state === 'off' && (
          <Button
            variant="primary"
            title="Turn on notifications"
            onPress={async () => {
              const next = await act(() => registerPush(true));
              if (next === 'on') act(async () => undefined, 'Notifications are on for this phone');
              setState(next ?? (await pushState()));
            }}
          />
        )}
        {state === 'denied' && <Muted>Notifications are blocked for Küü. Allow them in your phone’s Settings, then come back here.</Muted>}
        {state === 'unsupported' && <Muted>Push notifications aren’t available here (a simulator, the web preview, or a server with phone push turned off).</Muted>}
        <Muted size={12}>Per-channel preferences (all, mentions only, muted) are in each conversation’s details.</Muted>
      </View>
    </Section>
  );
}

function Security() {
  const { me, setMe } = useSession();
  const act = useAction();
  const [pw, setPw] = useState({ current: '', next: '' });
  const [disablePw, setDisablePw] = useState('');
  const [setup, setSetup] = useState(false);
  return (
    <>
      <Section title="Multifactor authentication">
        {me!.user.mfa_enabled ? (
          <View style={{ gap: 10 }}>
            <T>Enabled — you will be asked for a code from your authenticator app when you sign in.</T>
            {!me!.workspace.require_mfa && (
              <Row>
                <View style={{ flex: 1 }}>
                  <PasswordInput placeholder="Password to confirm" value={disablePw} onChangeText={setDisablePw} accessibilityLabel="Password" />
                </View>
                <Button
                  variant="danger"
                  title="Turn off"
                  disabled={!disablePw}
                  onPress={async () => {
                    const updated = await act(() => api.post<Me>('/me/mfa/disable', { password: disablePw }), 'Multifactor authentication turned off');
                    if (updated) setMe(updated);
                  }}
                />
              </Row>
            )}
          </View>
        ) : setup ? (
          <MfaSetupBody onDone={() => setSetup(false)} />
        ) : (
          <View style={{ gap: 10 }}>
            <Muted>Protect your account with a second step at sign-in.</Muted>
            <Button variant="primary" title="Set up MFA" onPress={() => setSetup(true)} />
          </View>
        )}
      </Section>
      <Section title="Password">
        <View style={{ gap: 12 }}>
          <Field label="Current password">
            <PasswordInput value={pw.current} onChangeText={(v) => setPw({ ...pw, current: v })} autoComplete="current-password" />
          </Field>
          <Field label="New password" hint="At least 8 characters.">
            <PasswordInput value={pw.next} onChangeText={(v) => setPw({ ...pw, next: v })} autoComplete="new-password" />
          </Field>
          <Button
            variant="primary"
            title="Change password"
            disabled={!pw.current || pw.next.length < 8}
            onPress={async () => {
              const ok = await act(() => api.post('/me/password', pw), 'Password changed. Other sessions were signed out.');
              if (ok) setPw({ current: '', next: '' });
            }}
          />
        </View>
      </Section>
      <Sessions />
      <Section title="Your data">
        <View style={{ gap: 10 }}>
          <Muted>Download everything you can access — messages, tasks, pages, file metadata, meetings and decisions — as JSON.</Muted>
          <Button icon="download" title="Export my data" onPress={() => act(() => shareApiDownload('/export', 'kuu-export.json', 'application/json'))} />
        </View>
      </Section>
      <DeleteAccount />
    </>
  );
}

interface SessionRow {
  id: string;
  device: string;
  ip: string | null;
  workspace_name: string;
  created_at: string;
  last_seen_at: string;
  current: boolean;
}

function Sessions() {
  const act = useAction();
  const { data, reload } = useApi<SessionRow[]>('/me/sessions');
  const others = data?.filter((s) => !s.current).length ?? 0;
  return (
    <Section title="Where you’re signed in">
      <Muted style={{ marginBottom: 6 }}>If you don’t recognise a device, sign it out and change your password.</Muted>
      {!data && <Loading inline />}
      {data?.map((s) => (
        <ListRow
          key={s.id}
          title={
            <Row gap={6}>
              <T weight="semibold" style={{ flexShrink: 1 }} numberOfLines={1}>
                {s.device}
              </T>
              {s.current && <Pill label="This phone" tone="accent" />}
            </Row>
          }
          subtitle={`${s.workspace_name}${s.ip ? ` · ${s.ip}` : ''} · signed in ${dateLabel(s.created_at)} · last active ${timeAgo(s.last_seen_at)}`}
          right={
            !s.current ? (
              <Button
                small
                variant="danger"
                title="Sign out"
                onPress={async () => {
                  await act(() => api.del(`/me/sessions/${s.id}`), 'Signed out');
                  reload();
                }}
              />
            ) : undefined
          }
        />
      ))}
      {others > 0 && (
        <Button
          title="Sign out all other devices"
          onPress={async () => {
            if (!(await confirm('Sign out everywhere except this phone?', undefined, 'Sign out'))) return;
            await act(() => api.post('/me/sessions/revoke-others'), 'Signed out of all other devices');
            reload();
          }}
        />
      )}
    </Section>
  );
}

function DeleteAccount() {
  const { c } = useTheme();
  const { me, forget } = useSession();
  const act = useAction();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ password: '', code: '', confirm: '' });
  return (
    <Card style={{ gap: 10, borderColor: c.redLine }}>
      <T size={17} weight="display" tone="red">
        Delete account
      </T>
      <Muted>
        Erases your name, email address, password and personal settings, and removes you from every workspace. Messages and work you shared stay with your teams, shown as “Deleted user”. If you're the only owner of a workspace, make someone else an owner or delete the workspace first.
      </Muted>
      <Button variant="danger" title="Delete my account" onPress={() => setOpen(true)} />
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Delete your account?"
        eyebrow="Danger"
        footer={
          <Button
            variant="danger"
            full
            title="Delete my account"
            disabled={form.confirm !== 'DELETE' || !form.password}
            onPress={async () => {
              const ok = await act(() => api.del('/me', { password: form.password, code: form.code || undefined }));
              if (ok) await forget();
            }}
          />
        }
      >
        <Field label="Type DELETE to confirm">
          <Input value={form.confirm} onChangeText={(v) => setForm({ ...form, confirm: v })} autoCapitalize="characters" autoCorrect={false} />
        </Field>
        <Field label="Your password">
          <PasswordInput value={form.password} onChangeText={(v) => setForm({ ...form, password: v })} />
        </Field>
        {me!.user.mfa_enabled && (
          <Field label="Authenticator code">
            <Input value={form.code} onChangeText={(v) => setForm({ ...form, code: v })} keyboardType="number-pad" textContentType="oneTimeCode" />
          </Field>
        )}
      </Sheet>
    </Card>
  );
}

function Onboarding() {
  const act = useAction();
  const { data, reload } = useApi<{ id: string; title: string; description: string; link: string; done_at: string | null }[]>('/onboarding');
  if (!data) return <Loading inline />;
  const done = data.filter((d) => d.done_at).length;
  return (
    <Section title="Getting started">
      {data.length ? (
        <View style={{ gap: 12 }}>
          <Muted>
            {done} of {data.length} complete
          </Muted>
          <ProgressBar value={data.length ? (done / data.length) * 100 : 0} />
          {data.map((item) => (
            <Row key={item.id} style={{ alignItems: 'flex-start' }}>
              <Checkbox
                checked={!!item.done_at}
                onChange={async () => {
                  await act(() => api.post(`/onboarding/${item.id}/toggle`));
                  reload();
                }}
              />
              <View style={{ flex: 1, gap: 2 }}>
                <T weight="semibold" style={item.done_at ? { textDecorationLine: 'line-through' } : undefined}>
                  {item.title}
                </T>
                {!!item.description && <Muted size={13}>{item.description}</Muted>}
              </View>
              {!!item.link && <LinkText onPress={() => (item.link.startsWith('/') ? router.push(item.link as never) : openLink(item.link))}>Open</LinkText>}
            </Row>
          ))}
        </View>
      ) : (
        <Muted>Your workspace has not set up an onboarding checklist.</Muted>
      )}
    </Section>
  );
}

function ApiTokens() {
  const { c } = useTheme();
  const { me } = useSession();
  const act = useAction();
  const toast = useToast();
  const { data, reload } = useApi<{ id: string; name: string; prefix: string; scope: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null; created_at: string }[]>('/integrations/tokens');
  const [form, setForm] = useState({ name: '', scope: 'read', expiresInDays: '90' });
  const [created, setCreated] = useState<string | null>(null);
  if (me!.role === 'guest') return <Muted>Guests cannot create API tokens.</Muted>;
  return (
    <>
      <Section title="Personal API tokens">
        <View style={{ gap: 12 }}>
          <Muted>Tokens let scripts and other tools use the Küü API as you, with your permissions. Send them as “Authorization: Bearer sx_…”.</Muted>
          <Field label="Name">
            <Input value={form.name} onChangeText={(v) => setForm({ ...form, name: v })} placeholder="e.g. Weekly report script" />
          </Field>
          <Row>
            <Field label="Access" style={{ flex: 1 }}>
              <Select
                title="Access"
                value={form.scope}
                onChange={(v) => setForm({ ...form, scope: v })}
                options={[
                  { id: 'read', label: 'Read only' },
                  { id: 'write', label: 'Read and write' },
                ]}
              />
            </Field>
            <Field label="Expires" style={{ flex: 1 }}>
              <Select
                title="Expires"
                value={form.expiresInDays}
                onChange={(v) => setForm({ ...form, expiresInDays: v })}
                options={[
                  { id: '30', label: 'In 30 days' },
                  { id: '90', label: 'In 90 days' },
                  { id: '365', label: 'In a year' },
                  { id: '', label: 'Never' },
                ]}
              />
            </Field>
          </Row>
          <Button
            variant="primary"
            title="Create token"
            disabled={!form.name.trim()}
            onPress={async () => {
              const res = await act(() => api.post<{ token: string }>('/integrations/tokens', { name: form.name, scope: form.scope, expiresInDays: form.expiresInDays ? Number(form.expiresInDays) : null }));
              if (res) {
                setCreated(res.token);
                setForm({ ...form, name: '' });
                reload();
              }
            }}
          />
          {created && (
            <View style={{ gap: 8, padding: 12, borderRadius: 12, backgroundColor: c.amberSoft }}>
              <T weight="bold">Copy your token now — it will not be shown again.</T>
              <T size={13} selectable>
                {created}
              </T>
              <Button
                small
                title="Copy"
                onPress={async () => {
                  await Clipboard.setStringAsync(created);
                  toast('Token copied');
                }}
              />
            </View>
          )}
        </View>
      </Section>
      <Card padded={false} style={{ paddingHorizontal: 14 }}>
        {!data && <Loading inline />}
        {data && !data.length && <Muted style={{ paddingVertical: 12 }}>No tokens yet.</Muted>}
        {data?.map((t) => (
          <ListRow
            key={t.id}
            style={t.revoked_at ? { opacity: 0.5 } : undefined}
            title={
              <Row gap={6}>
                <T weight="semibold">{t.name}</T>
                <Pill label={t.scope === 'write' ? 'Read & write' : 'Read only'} />
              </Row>
            }
            subtitle={`${t.prefix}… · created ${dateLabel(t.created_at)} · ${t.last_used_at ? `last used ${timeAgo(t.last_used_at)}` : 'never used'}${t.expires_at ? ` · expires ${dateLabel(t.expires_at)}` : ''}${t.revoked_at ? ' · revoked' : ''}`}
            right={
              !t.revoked_at ? (
                <Button
                  small
                  variant="danger"
                  title="Revoke"
                  onPress={async () => {
                    if (!(await confirm(`Revoke “${t.name}”?`, 'Anything using it will stop working immediately.', 'Revoke'))) return;
                    await act(() => api.del(`/integrations/tokens/${t.id}`), 'Token revoked');
                    reload();
                  }}
                />
              ) : undefined
            }
          />
        ))}
      </Card>
    </>
  );
}
