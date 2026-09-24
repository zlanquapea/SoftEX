import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type Me } from '../api';
import { Field, Loading } from '../components/ui';
import { useApi } from '../hooks';
import { useSession } from '../session';
import { ROLE_LABEL } from '../format';

function AuthFrame({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand dark">
          <span className="brand-mark">S</span>
          <span>SoftEX</span>
        </div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
        {children}
      </div>
      <p className="auth-foot muted">One calm workspace for conversations, projects, knowledge and meetings.</p>
    </div>
  );
}

export function Login() {
  const { setMe } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setMe(await api.post<Me>('/auth/login', { email, password, code: needCode ? code : undefined }));
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.details?.code === 'mfa_required') setNeedCode(true);
      setError(apiErr.details?.code === 'mfa_required' && !needCode ? '' : apiErr.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame title="Welcome back" subtitle="Sign in to your workspace.">
      <form className="form" onSubmit={submit}>
        {error && <p className="form-error" role="alert">{error}</p>}
        <Field label="Work email">
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Password">
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {needCode && (
          <Field label="Authenticator code" hint="Open your authenticator app and enter the 6-digit code.">
            <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          </Field>
        )}
        <button className="btn primary block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="muted center">
        New to SoftEX? <Link to="/register">Create a workspace</Link>
      </p>
    </AuthFrame>
  );
}

export function Register() {
  const { setMe } = useSession();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', workspaceName: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setMe(await api.post<Me>('/auth/register', form));
      navigate('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame title="Create your workspace" subtitle="You will be the workspace owner. Invite your team next.">
      <form className="form" onSubmit={submit}>
        {error && <p className="form-error" role="alert">{error}</p>}
        <Field label="Your name">
          <input required autoComplete="name" value={form.name} onChange={set('name')} autoFocus />
        </Field>
        <Field label="Work email">
          <input type="email" required autoComplete="email" value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <input type="password" required minLength={8} autoComplete="new-password" value={form.password} onChange={set('password')} />
        </Field>
        <Field label="Workspace name">
          <input required minLength={2} placeholder="e.g. Acme Studio" value={form.workspaceName} onChange={set('workspaceName')} />
        </Field>
        <button className="btn primary block" disabled={busy}>
          {busy ? 'Creating…' : 'Create workspace'}
        </button>
      </form>
      <p className="muted center">
        Already have an account? <Link to="/">Sign in</Link>
      </p>
    </AuthFrame>
  );
}

export function AcceptInvite() {
  const { token } = useParams();
  const { setMe } = useSession();
  const navigate = useNavigate();
  const { data: invite, error: loadError } = useApi<{ email: string; role: string; workspace_name: string; inviter_name: string; existing_account: boolean }>(
    `/invitations/${token}`,
  );
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  if (loadError) {
    return (
      <AuthFrame title="Invitation unavailable" subtitle={loadError.message}>
        <Link className="btn block" to="/">
          Go to sign in
        </Link>
      </AuthFrame>
    );
  }
  if (!invite) return <Loading />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      setMe(await api.post<Me>(`/invitations/${token}/accept`, { name: invite.existing_account ? undefined : name, password }));
      navigate('/');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <AuthFrame
      title={`Join ${invite.workspace_name}`}
      subtitle={
        <>
          {invite.inviter_name} invited <strong>{invite.email}</strong> as {ROLE_LABEL[invite.role]?.toLowerCase()}.
        </>
      }
    >
      <form className="form" onSubmit={submit}>
        {error && <p className="form-error" role="alert">{error}</p>}
        {!invite.existing_account && (
          <Field label="Your name">
            <input required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
        )}
        <Field label={invite.existing_account ? 'Your SoftEX password' : 'Choose a password'} hint={invite.existing_account ? undefined : 'At least 8 characters.'}>
          <input type="password" required minLength={invite.existing_account ? 1 : 8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <button className="btn primary block">Accept invitation</button>
      </form>
    </AuthFrame>
  );
}

export function MfaSetup({ required = false, onDone }: { required?: boolean; onDone?: () => void }) {
  const { setMe, logout } = useSession();
  const [secret, setSecret] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const begin = async () => {
    setError('');
    try {
      setSecret(await api.post('/me/mfa/setup'));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setMe(await api.post<Me>('/me/mfa/enable', { code }));
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const body = (
    <div className="form">
      {error && <p className="form-error" role="alert">{error}</p>}
      {!secret ? (
        <button className="btn primary block" onClick={begin}>
          Set up authenticator app
        </button>
      ) : (
        <form className="form" onSubmit={confirm}>
          <ol className="steps">
            <li>
              Open an authenticator app (1Password, Google Authenticator, Authy…) and add an account using this setup key:
              <code className="secret">{secret.secret.match(/.{1,4}/g)!.join(' ')}</code>
              <a href={secret.otpauth_url}>Or open it directly on this device</a>
            </li>
            <li>Enter the 6-digit code it shows.</li>
          </ol>
          <Field label="Code">
            <input inputMode="numeric" pattern="\d{6}" required value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          </Field>
          <button className="btn primary block">Turn on multifactor authentication</button>
        </form>
      )}
    </div>
  );
  if (!required) return body;
  return (
    <AuthFrame title="Secure your account" subtitle="Your workspace requires multifactor authentication before you continue.">
      {body}
      <button className="link-btn center" onClick={logout}>
        Sign out
      </button>
    </AuthFrame>
  );
}
