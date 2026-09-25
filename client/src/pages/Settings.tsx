import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type Me } from '../api';
import { Icon } from '../components/Icon';
import { Field, Loading, Modal, Tabs, useAction } from '../components/ui';
import { UpgradeNotice, usePlan } from '../components/Plan';
import { useApi } from '../hooks';
import { useSession } from '../session';
import { MfaSetup } from './Auth';
import { disablePush, enablePush, pushState, type PushState } from '../pwa';

type Tab = 'profile' | 'notifications' | 'security' | 'api' | 'onboarding';

export function Settings() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'profile';
  const { has } = usePlan();
  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Your profile, notifications and account security.</p>
        </div>
      </div>
      <Tabs
        value={tab}
        onChange={(t) => setParams({ tab: t })}
        tabs={[
          { id: 'profile', label: 'Profile' },
          { id: 'notifications', label: 'Notifications & focus' },
          { id: 'security', label: 'Security' },
          { id: 'api', label: 'API tokens' },
          { id: 'onboarding', label: 'Onboarding' },
        ]}
      />
      {tab === 'profile' && <Profile />}
      {tab === 'notifications' && <Notifications />}
      {tab === 'security' && <Security />}
      {tab === 'api' && (has('api') ? <ApiTokens /> : <UpgradeNotice feature="api" />)}
      {tab === 'onboarding' && <Onboarding />}
    </div>
  );
}

const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC'];
  }
})();

function Profile() {
  const { me, setMe, reloadPeople } = useSession();
  const act = useAction();
  const u = me!.user;
  const [form, setForm] = useState({
    name: u.name,
    title: u.title,
    timezone: u.timezone,
    working_hours: u.working_hours,
    status_text: u.status_text,
    expertise: u.expertise.join(', '),
  });
  return (
    <form
      className="card form"
      onSubmit={async (e) => {
        e.preventDefault();
        const updated = await act(
          () => api.patch<Me>('/me', { ...form, expertise: form.expertise.split(',').map((s) => s.trim()).filter(Boolean) }),
          'Profile saved',
        );
        if (updated) {
          setMe(updated);
          reloadPeople();
        }
      }}
    >
      <div className="form-row">
        <Field label="Name">
          <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Title">
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Product designer" />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Time zone">
          <select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
            {ZONES.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Working hours">
          <input value={form.working_hours} onChange={(e) => setForm({ ...form, working_hours: e.target.value })} placeholder="09:00-17:00" />
        </Field>
      </div>
      <Field label="Status message">
        <input value={form.status_text} onChange={(e) => setForm({ ...form, status_text: e.target.value })} placeholder="e.g. In workshops until 2pm" maxLength={100} />
      </Field>
      <Field label="Expertise" hint="Comma separated. Helps colleagues find you in the directory.">
        <input value={form.expertise} onChange={(e) => setForm({ ...form, expertise: e.target.value })} placeholder="Research, Figma, Accessibility" />
      </Field>
      {form.timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone && (
        <p className="hint-box">
          This device is in {Intl.DateTimeFormat().resolvedOptions().timeZone}.{' '}
          <button type="button" className="link-btn" onClick={() => setForm({ ...form, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}>
            Use it
          </button>
        </p>
      )}
      <div className="form-actions">
        <button className="btn primary">Save profile</button>
      </div>
    </form>
  );
}

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
  return (
    <>
      <div className="card form">
        <h2>Focus time</h2>
        <p className="muted">During focus time, notifications are collected in your Inbox without interrupting you. Urgent messages still come through.</p>
        {focusActive ? (
          <p>
            <strong>Focusing until {new Date(me!.user.focus_until!).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.</strong>{' '}
            <button className="link-btn" onClick={() => setFocus(null)}>
              End now
            </button>
          </p>
        ) : (
          <div className="row-gap wrap">
            {[30, 60, 120, 240].map((m) => (
              <button key={m} className="btn" onClick={() => setFocus(m)}>
                <Icon name="moon" size={15} /> {m >= 60 ? `${m / 60} h` : `${m} min`}
              </button>
            ))}
          </div>
        )}
      </div>
      <form
        className="card form"
        onSubmit={async (e) => {
          e.preventDefault();
          const updated = await act(() => api.patch<Me>('/me', { quiet_start: quiet.start || null, quiet_end: quiet.end || null }), 'Quiet hours saved');
          if (updated) setMe(updated);
        }}
      >
        <h2>Quiet hours</h2>
        <p className="muted">A daily window, in your time zone ({me!.user.timezone}), when non-urgent notifications stay silent.</p>
        <div className="form-row">
          <Field label="From">
            <input type="time" value={quiet.start} onChange={(e) => setQuiet({ ...quiet, start: e.target.value })} />
          </Field>
          <Field label="Until">
            <input type="time" value={quiet.end} onChange={(e) => setQuiet({ ...quiet, end: e.target.value })} />
          </Field>
        </div>
        <div className="form-actions">
          {(quiet.start || quiet.end) && (
            <button type="button" className="btn" onClick={() => setQuiet({ start: '', end: '' })}>
              Clear
            </button>
          )}
          <button className="btn primary">Save quiet hours</button>
        </div>
      </form>
      <div className="card form">
        <h2>Email</h2>
        <label className="check-row">
          <input
            type="checkbox"
            checked={me!.user.email_digest}
            onChange={async (e) => {
              const updated = await act(() => api.patch<Me>('/me', { email_digest: e.target.checked }), 'Email preference saved');
              if (updated) setMe(updated);
            }}
          />
          <span>
            <strong>Morning digest</strong>
            <small className="muted block">At 8am in your time zone, if you have unread notifications.</small>
          </span>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={me!.user.email_urgent}
            onChange={async (e) => {
              const updated = await act(() => api.patch<Me>('/me', { email_urgent: e.target.checked }), 'Email preference saved');
              if (updated) setMe(updated);
            }}
          />
          <span>
            <strong>Urgent messages while I am away</strong>
            <small className="muted block">Only when you are not connected to SoftEX.</small>
          </span>
        </label>
        <p className="muted small">Invitations, password resets and meeting invitations are always emailed.</p>
      </div>
      <DeviceNotifications />
    </>
  );
}

/** Push notifications for this phone or computer, including when SoftEX is closed. */
function DeviceNotifications() {
  const act = useAction();
  const { data: config } = useApi<{ enabled: boolean; publicKey?: string }>('/push/config');
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (config) void pushState(config.enabled).then(setState);
  }, [config]);
  const turnOn = async () => {
    setBusy(true);
    try {
      const ok = await act(() => enablePush(config!.publicKey!, (sub) => api.post('/me/push', sub)), 'Notifications are on for this device');
      if (ok === false && Notification.permission === 'denied') setState('denied');
      else setState(await pushState(true));
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async () => {
    setBusy(true);
    try {
      const endpoint = await disablePush();
      if (endpoint) await act(() => api.del('/me/push', { endpoint }), 'Notifications are off for this device');
      setState(await pushState(true));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card form">
      <h2>Notifications on this device</h2>
      <p className="muted">
        Get mentions, assignments and urgent messages on this phone or computer when SoftEX is closed. They follow your quiet hours and focus time, except urgent
        messages.
      </p>
      {state === null && <Loading />}
      {state === 'on' && (
        <div className="row-gap">
          <span>
            <Icon name="check" size={16} /> On for this device.
          </span>
          <button className="btn sm" disabled={busy} onClick={() => act(() => api.post('/me/push/test'), 'Test notification sent')}>
            Send a test
          </button>
          <button className="btn sm danger-text" disabled={busy} onClick={turnOff}>
            Turn off
          </button>
        </div>
      )}
      {state === 'off' && (
        <div>
          <button className="btn primary" disabled={busy} onClick={turnOn}>
            Turn on notifications
          </button>
          <small className="muted block">On iPhone and iPad, first add SoftEX to your Home Screen (Share → Add to Home Screen), then open it from there.</small>
        </div>
      )}
      {state === 'denied' && <p className="muted">Notifications are blocked for this site. Allow them in your browser’s site settings, then reload.</p>}
      {state === 'unavailable' && <p className="muted">Push notifications aren’t available here. Install SoftEX (or open the production site) to use them.</p>}
      {state === 'unsupported' && <p className="muted">This browser doesn’t support notifications.</p>}
      <p className="muted small">Per-channel preferences (all, mentions only, muted) are in each channel’s header.</p>
    </div>
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
      <div className="card form">
        <h2>Multifactor authentication</h2>
        {me!.user.mfa_enabled ? (
          <>
            <p>
              <Icon name="shield" size={16} /> Enabled — you will be asked for a code from your authenticator app when you sign in.
            </p>
            {!me!.workspace.require_mfa && (
              <form
                className="row-gap"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const updated = await act(() => api.post<Me>('/me/mfa/disable', { password: disablePw }), 'Multifactor authentication turned off');
                  if (updated) setMe(updated);
                }}
              >
                <input type="password" placeholder="Password to confirm" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} aria-label="Password" required />
                <button className="btn danger-text">Turn off</button>
              </form>
            )}
          </>
        ) : setup ? (
          <MfaSetup onDone={() => setSetup(false)} />
        ) : (
          <>
            <p className="muted">Protect your account with a second step at sign-in.</p>
            <button className="btn primary" onClick={() => setSetup(true)}>
              Set up MFA
            </button>
          </>
        )}
      </div>
      <form
        className="card form"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await act(() => api.post('/me/password', pw), 'Password changed. Other sessions were signed out.');
          if (ok) setPw({ current: '', next: '' });
        }}
      >
        <h2>Password</h2>
        <div className="form-row">
          <Field label="Current password">
            <input type="password" autoComplete="current-password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </Field>
          <Field label="New password" hint="At least 8 characters.">
            <input type="password" autoComplete="new-password" required minLength={8} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          </Field>
        </div>
        <div className="form-actions">
          <button className="btn primary">Change password</button>
        </div>
      </form>
      <Sessions />
      <div className="card form">
        <h2>Your data</h2>
        <p className="muted">Download everything you can access — messages, tasks, pages, file metadata, meetings and decisions — as JSON.</p>
        <a className="btn" href="/api/export">
          <Icon name="download" size={16} /> Export my data
        </a>
      </div>
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
    <div className="card form">
      <h2>Where you’re signed in</h2>
      <p className="muted">If you don’t recognise a device, sign it out and change your password.</p>
      {!data && <Loading />}
      {data?.map((s) => (
        <div key={s.id} className="list-row">
          <span className="grow">
            <strong>{s.device}</strong> {s.current && <span className="pill">This device</span>}
            <small className="muted block">
              {s.workspace_name}
              {s.ip && ` · ${s.ip}`} · signed in {new Date(s.created_at).toLocaleDateString()} · last active {new Date(s.last_seen_at).toLocaleString()}
            </small>
          </span>
          {!s.current && (
            <button
              className="btn sm danger-text"
              onClick={async () => {
                await act(() => api.del(`/me/sessions/${s.id}`), 'Signed out');
                reload();
              }}
            >
              Sign out
            </button>
          )}
        </div>
      ))}
      {others > 0 && (
        <div className="form-actions">
          <button
            className="btn"
            onClick={async () => {
              if (!confirm('Sign out everywhere except this device?')) return;
              await act(() => api.post('/me/sessions/revoke-others'), 'Signed out of all other devices');
              reload();
            }}
          >
            Sign out all other devices
          </button>
        </div>
      )}
    </div>
  );
}

function DeleteAccount() {
  const { me, setMe } = useSession();
  const act = useAction();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ password: '', code: '', confirm: '' });
  return (
    <div className="card form danger-zone">
      <h2>Delete account</h2>
      <p className="muted">
        Erases your name, email address, password and personal settings, and removes you from every workspace. Messages and work you shared stay with your teams, shown as
        “Deleted user”. If you're the only owner of a workspace, make someone else an owner or delete the workspace first.
      </p>
      <button className="btn danger" onClick={() => setOpen(true)}>
        Delete my account
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Delete your account?" eyebrow="DANGER">
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await act(() => api.del('/me', { password: form.password, code: form.code || undefined }));
            if (ok) setMe(null);
          }}
        >
          <Field label="Type DELETE to confirm">
            <input required value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Your password">
            <input required type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
          {me!.user.mfa_enabled && (
            <Field label="Authenticator code">
              <input required inputMode="numeric" autoComplete="one-time-code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
            </Field>
          )}
          <div className="row-gap">
            <span className="grow" />
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn danger" disabled={form.confirm !== 'DELETE'}>
              Delete my account
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function Onboarding() {
  const act = useAction();
  const { data, reload } = useApi<{ id: string; title: string; description: string; link: string; done_at: string | null }[]>('/onboarding');
  if (!data) return <Loading />;
  const done = data.filter((d) => d.done_at).length;
  return (
    <div className="card">
      <h2>Getting started</h2>
      {data.length ? (
        <>
          <p className="muted">
            {done} of {data.length} complete
          </p>
          <div className="progress">
            <i style={{ width: `${data.length ? (done / data.length) * 100 : 0}%` }} />
          </div>
          {data.map((item) => (
            <label key={item.id} className="check-row onboarding-item">
              <input
                type="checkbox"
                checked={!!item.done_at}
                onChange={async () => {
                  await act(() => api.post(`/onboarding/${item.id}/toggle`));
                  reload();
                }}
              />
              <span className="grow">
                <strong className={item.done_at ? 'done' : ''}>{item.title}</strong>
                {item.description && <small className="muted block">{item.description}</small>}
              </span>
              {item.link && (
                <a href={item.link} className="link-btn" target={item.link.startsWith('/') ? undefined : '_blank'} rel="noopener noreferrer">
                  Open
                </a>
              )}
            </label>
          ))}
        </>
      ) : (
        <p className="muted">Your workspace has not set up an onboarding checklist.</p>
      )}
    </div>
  );
}

function ApiTokens() {
  const { me } = useSession();
  const act = useAction();
  const { data, reload } = useApi<{ id: string; name: string; prefix: string; scope: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null; created_at: string }[]>(
    '/integrations/tokens',
  );
  const [form, setForm] = useState({ name: '', scope: 'read', expiresInDays: '90' });
  const [created, setCreated] = useState<string | null>(null);
  if (me!.role === 'guest') return <div className="card muted">Guests cannot create API tokens.</div>;
  return (
    <>
      <form
        className="card form"
        onSubmit={async (e) => {
          e.preventDefault();
          const res = await act(() =>
            api.post<{ token: string }>('/integrations/tokens', { name: form.name, scope: form.scope, expiresInDays: form.expiresInDays ? Number(form.expiresInDays) : null }),
          );
          if (res) {
            setCreated(res.token);
            setForm({ ...form, name: '' });
            reload();
          }
        }}
      >
        <h2>Personal API tokens</h2>
        <p className="muted">
          Tokens let scripts and other tools use the SoftEX API as you, with your permissions. Send them as <code>Authorization: Bearer sx_…</code>. See{' '}
          <a href="https://github.com/zlanquapea/SoftEX/blob/main/docs/API.md" target="_blank" rel="noopener noreferrer">
            the API guide
          </a>
          .
        </p>
        <div className="form-row">
          <Field label="Name">
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Weekly report script" />
          </Field>
          <Field label="Access">
            <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
              <option value="read">Read only</option>
              <option value="write">Read and write</option>
            </select>
          </Field>
          <Field label="Expires">
            <select value={form.expiresInDays} onChange={(e) => setForm({ ...form, expiresInDays: e.target.value })}>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In a year</option>
              <option value="">Never</option>
            </select>
          </Field>
        </div>
        <div className="form-actions">
          <button className="btn primary">Create token</button>
        </div>
        {created && (
          <div className="hint-box token-reveal">
            <strong>Copy your token now — it will not be shown again.</strong>
            <code className="secret">{created}</code>
            <button type="button" className="btn sm" onClick={() => navigator.clipboard?.writeText(created)}>
              Copy
            </button>
          </div>
        )}
      </form>
      <div className="card">
        {!data && <Loading />}
        {data && !data.length && <p className="muted">No tokens yet.</p>}
        {data?.map((t) => (
          <div key={t.id} className={`list-row ${t.revoked_at ? 'muted-row' : ''}`}>
            <span className="grow">
              <strong>{t.name}</strong> <span className="pill">{t.scope === 'write' ? 'Read & write' : 'Read only'}</span>
              <small className="muted block">
                <code>{t.prefix}…</code> · created {new Date(t.created_at).toLocaleDateString()} · {t.last_used_at ? `last used ${new Date(t.last_used_at).toLocaleString()}` : 'never used'}
                {t.expires_at && ` · expires ${new Date(t.expires_at).toLocaleDateString()}`}
                {t.revoked_at && ' · revoked'}
              </small>
            </span>
            {!t.revoked_at && (
              <button
                className="btn sm danger-text"
                onClick={async () => {
                  if (!confirm(`Revoke “${t.name}”? Anything using it will stop working immediately.`)) return;
                  await act(() => api.del(`/integrations/tokens/${t.id}`), 'Token revoked');
                  reload();
                }}
              >
                Revoke
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
