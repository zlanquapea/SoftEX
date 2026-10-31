import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type Me } from '../api';
import { Callout, FormError, FormField, Loading, PasswordInput } from '@/components/kit';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useApi } from '../hooks';
import { useSession } from '../session';
import { ROLE_LABEL, allowanceBytes } from '../format';
import { usePublicPricing } from './Pricing';
import { Logo, TAGLINE } from '../components/Logo';
import { Input } from '@/components/ui/input';
import { Button, buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

const LINK = 'font-medium text-primary underline-offset-4 hover:underline';

function AuthFrame({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="gap-3">
          <Link to="/" aria-label="Küü home" className="mb-2 w-fit">
            <Logo height={34} />
          </Link>
          <CardTitle aria-level={1} className="font-heading text-2xl font-semibold tracking-tight">{title}</CardTitle>
          {subtitle && <CardDescription className="[&_a]:text-primary [&_a]:underline-offset-4 [&_a:hover]:underline">{subtitle}</CardDescription>}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
      </Card>
      <p className="text-sm text-muted-foreground">{TAGLINE}</p>
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
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <FormError>{error}</FormError>
        <FormField label="Work email">
          <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </FormField>
        {!ssoMode && (
          <FormField label="Password">
            <PasswordInput autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </FormField>
        )}
        {needCode && (
          <FormField label="Authenticator code" hint="Open your authenticator app and enter the 6-digit code.">
            <Input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          </FormField>
        )}
        {ssoMode ? (
          <Button className="w-full" type="button" onClick={startSso}>
            Continue with single sign-on
          </Button>
        ) : (
          <Button className="w-full" disabled={busy} type="submit">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <Button
            variant="link"
            size="inline"
            type="button"
            onClick={() => (ssoMode ? setSsoMode(false) : (setSsoMode(true), setError('')))}>
            {ssoMode ? 'Use a password instead' : 'Sign in with SSO'}
          </Button>
          <Link to="/forgot-password" className={LINK}>
            Forgot password?
          </Link>
        </div>
      </form>
      <p className="text-center text-sm text-muted-foreground">
        New to Küü?{' '}
        <Link to="/register" className={LINK}>
          Create a workspace
        </Link>
        {pricing?.mode === 'saas' && (
          <>
            {' · '}
            <Link to="/pricing" className={LINK}>
              Pricing
            </Link>
          </>
        )}
      </p>
    </AuthFrame>
  );
}

/** Required on hosted servers: agree to the terms before an account is created. */
function TermsCheckbox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Label className="flex items-start gap-2.5 font-normal leading-snug">
      <Checkbox
        required
        checked={checked}
        onCheckedChange={(checked) => onChange(checked)} />
      <span>
        I agree to the{' '}
        <a href="/terms" target="_blank" rel="noopener" className={LINK}>
          Terms of Service
        </a>{' '}
        and{' '}
        <a href="/privacy" target="_blank" rel="noopener" className={LINK}>
          Privacy Policy
        </a>
        .
      </span>
    </Label>
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
            Start a {pricing.trial_days}-day free trial of Organization — no payment needed. Afterwards, keep the Free plan
            {(() => {
              const free = pricing.plans.find((p) => p.id === 'free');
              return free ? ` (${free.member_limit} members, ${allowanceBytes(free.storage_bytes)} storage, ${free.project_limit ?? 'unlimited'} active projects)` : '';
            })()}{' '}
            or <Link to="/pricing">choose a plan</Link>. Nothing is ever deleted when a trial ends.
          </>
        ) : (
          'You will be the workspace owner. Invite your team next.'
        )
      }
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <FormError>{error}</FormError>
        <FormField label="Your name">
          <Input required autoComplete="name" value={form.name} onChange={set('name')} autoFocus />
        </FormField>
        <FormField label="Work email">
          <Input type="email" required autoComplete="email" value={form.email} onChange={set('email')} />
        </FormField>
        <FormField label="Password" hint="At least 8 characters.">
          <PasswordInput required minLength={8} autoComplete="new-password" value={form.password} onChange={set('password')} />
        </FormField>
        <FormField label="Workspace name">
          <Input required minLength={2} placeholder="e.g. Acme Studio" value={form.workspaceName} onChange={set('workspaceName')} />
        </FormField>
        {pricing?.mode === 'saas' && <TermsCheckbox checked={form.acceptTerms} onChange={(v) => setForm({ ...form, acceptTerms: v })} />}
        <Button className="w-full" disabled={busy} type="submit">
          {busy ? 'Creating…' : 'Create workspace'}
        </Button>
      </form>
      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link to="/login" className={LINK}>
          Sign in
        </Link>
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
        <Link
          to="/login"
          className={buttonVariants({
            variant: "outline",
            className: "w-full"
          })}>Go to sign in
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
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <FormError>{error}</FormError>
        {!invite.existing_account && (
          <FormField label="Your name">
            <Input required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </FormField>
        )}
        <FormField label={invite.existing_account ? 'Your Küü password' : 'Choose a password'} hint={invite.existing_account ? undefined : 'At least 8 characters.'}>
          <PasswordInput required minLength={invite.existing_account ? 1 : 8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </FormField>
        {!invite.existing_account && pricing?.mode === 'saas' && <TermsCheckbox checked={acceptTerms} onChange={setAcceptTerms} />}
        <Button className="w-full" type="submit">Accept invitation</Button>
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
    <div className="flex flex-col gap-4">
      <FormError>{error}</FormError>
      {!secret ? (
        <Button className="w-full" onClick={begin}>
          Set up authenticator app
        </Button>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={confirm}>
          <ol className="ml-5 flex list-decimal flex-col gap-3 text-sm marker:text-muted-foreground">
            <li className="flex flex-col gap-2">
              Open an authenticator app (1Password, Google Authenticator, Authy…) and add an account using this setup key:
              <code className="rounded-lg border bg-muted px-3 py-2 font-mono text-sm tracking-widest select-all">{secret.secret.match(/.{1,4}/g)!.join(' ')}</code>
              <a href={secret.otpauth_url} className={LINK}>
                Or open it directly on this device
              </a>
            </li>
            <li>Enter the 6-digit code it shows.</li>
          </ol>
          <FormField label="Code">
            <Input inputMode="numeric" pattern="\d{6}" required value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          </FormField>
          <Button className="w-full" type="submit">Turn on multifactor authentication</Button>
        </form>
      )}
    </div>
  );
  if (!required) return body;
  return (
    <AuthFrame title="Secure your account" subtitle="Your workspace requires multifactor authentication before you continue.">
      {body}
      <Button variant="link" size="inline" className="mx-auto flex" onClick={logout}>
        Sign out
      </Button>
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
        <div className="flex flex-col gap-4">
          <Callout tone="info">If an account exists for {email}, a reset link is on its way. It works for one hour.</Callout>
          <Link
            to="/login"
            className={buttonVariants({
              variant: "outline",
              className: "w-full"
            })}>Back to sign in
                      </Link>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
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
          <FormError>{error}</FormError>
          <FormField label="Work email">
            <Input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          </FormField>
          <Button className="w-full" type="submit">Email me a reset link</Button>
          <Link className={buttonVariants({ variant: 'ghost', className: 'w-full' })} to="/login">
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
        <div className="flex flex-col gap-4">
          <Callout tone="info">Your password was changed and you were signed out everywhere.</Callout>
          <Link
            to="/login"
            className={buttonVariants({
              className: "w-full"
            })}>Sign in
                      </Link>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
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
          <FormError>{error}</FormError>
          <FormField label="New password" hint="At least 8 characters.">
            <PasswordInput required minLength={8} autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          </FormField>
          <FormField label="Repeat new password">
            <PasswordInput required minLength={8} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </FormField>
          <Button className="w-full" type="submit">Change password</Button>
        </form>
      )}
    </AuthFrame>
  );
}
