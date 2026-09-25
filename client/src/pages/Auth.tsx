import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type Me } from '../api';
import { Field, Loading } from '../components/ui';
import { useApi } from '../hooks';
import { useSession } from '../session';
import { ROLE_LABEL } from '../format';
import { usePublicPricing } from './Pricing';

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
  const [error, setError] = useState(() => new URLSearchParams(location.search).get('sso_error') ?? '');
  const [busy, setBusy] = useState(false);
  const [ssoMode, setSsoMode] = useState(false);
  const { data: pricing } = usePublicPricing();
  const startSso = async () => {
    setError('');
    if (!email) return setError('Enter your work email first');
    try {
      const found = await api.get<{ sso: boolean }>(`/auth/sso/discover?email=${encodeURIComponent(email)}`);
      if (!found.sso) return setError('Single sign-on is not set up for this email domain. Sign in with your password instead.');
      window.location.href = `/api/auth/sso/start?email=${encodeURIComponent(email)}`;
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setMe(await api.post<Me>('/auth/login', { email, password, code: needCode ? code : undefined }));
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.details?.code === 'mfa_required') setNeedCode(true);
      if (apiErr.details?.code === 'sso_required') setSsoMode(true);
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
        {!ssoMode && (
          <Field label="Password">
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        )}
        {needCode && (
          <Field label="Authenticator code" hint="Open your authenticator app and enter the 6-digit code.">
            <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          </Field>
        )}
        {ssoMode ? (
          <button type="button" className="btn primary block" onClick={startSso}>
            Continue with single sign-on
          </button>
        ) : (
          <button className="btn primary block" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        )}
        <div className="auth-links">
          <button type="button" className="link-btn" onClick={() => (ssoMode ? setSsoMode(false) : (setSsoMode(true), setError('')))}>
            {ssoMode ? 'Use a password instead' : 'Sign in with SSO'}
          </button>
          <Link to="/forgot-password">Forgot password?</Link>
        </div>
      </form>
      <p className="muted center">
        New to SoftEX? <Link to="/register">Create a workspace</Link>
        {pricing?.mode === 'saas' && (
          <>
            {' · '}
            <Link to="/pricing">Pricing</Link>
          </>
        )}
      </p>
    </AuthFrame>
  );
}

/** Required on hosted servers: agree to the terms before an account is created. */
function TermsCheckbox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check-row terms-check">
      <input type="checkbox" required checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        I agree to the{' '}
        <a href="/terms" target="_blank" rel="noopener">
          Terms of Service
        </a>{' '}
        and{' '}
        <a href="/privacy" target="_blank" rel="noopener">
          Privacy Policy
        </a>
        .
      </span>
    </label>
  );
}

export function Register() {
  const { setMe } = useSession();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', workspaceName: '', acceptTerms: false });
  const { data: pricing } = usePublicPricing();
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
    <AuthFrame
      title="Create your workspace"
      subtitle={
        pricing?.mode === 'saas' ? (
          <>
            Start a {pricing.trial_days}-day free trial of Business — no payment needed. Afterwards, keep a free plan or <Link to="/pricing">choose a plan</Link>.
          </>
        ) : (
          'You will be the workspace owner. Invite your team next.'
        )
      }
    >
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
        {pricing?.mode === 'saas' && <TermsCheckbox checked={form.acceptTerms} onChange={(v) => setForm({ ...form, acceptTerms: v })} />}
        <button className="btn primary block" disabled={busy}>
          {busy ? 'Creating…' : 'Create workspace'}
        </button>
      </form>
      <p className="muted center">
        Already have an account? <Link to="/login">Sign in</Link>
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
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [error, setError] = useState('');
  const { data: pricing } = usePublicPricing();
  if (loadError) {
    return (
      <AuthFrame title="Invitation unavailable" subtitle={loadError.message}>
        <Link className="btn block" to="/login">
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
      setMe(await api.post<Me>(`/invitations/${token}/accept`, { name: invite.existing_account ? undefined : name, password, acceptTerms }));
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
        {!invite.existing_account && pricing?.mode === 'saas' && <TermsCheckbox checked={acceptTerms} onChange={setAcceptTerms} />}
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

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  return (
    <AuthFrame title="Reset your password" subtitle="We will email you a link to choose a new password.">
      {sent ? (
        <div className="form">
          <p className="hint-box">If an account exists for {email}, a reset link is on its way. It works for one hour.</p>
          <Link className="btn block" to="/login">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.post('/auth/forgot', { email });
              setSent(true);
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          {error && <p className="form-error" role="alert">{error}</p>}
          <Field label="Work email">
            <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <button className="btn primary block">Email me a reset link</button>
          <Link className="center" to="/login">
            Back to sign in
          </Link>
        </form>
      )}
    </AuthFrame>
  );
}

export function ResetPassword() {
  const { token } = useParams();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  return (
    <AuthFrame title="Choose a new password">
      {done ? (
        <div className="form">
          <p className="hint-box">Your password was changed and you were signed out everywhere.</p>
          <Link className="btn primary block" to="/login">
            Sign in
          </Link>
        </div>
      ) : (
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (password !== confirm) return setError('The passwords do not match');
            try {
              await api.post('/auth/reset', { token, password });
              setDone(true);
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          {error && <p className="form-error" role="alert">{error}</p>}
          <Field label="New password" hint="At least 8 characters.">
            <input type="password" required minLength={8} autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Repeat new password">
            <input type="password" required minLength={8} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <button className="btn primary block">Change password</button>
        </form>
      )}
    </AuthFrame>
  );
}
