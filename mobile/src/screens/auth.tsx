import * as Crypto from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, ApiError, DEFAULT_SERVER, normaliseServer, session, type Me } from '../lib/api';
import { ROLE_LABEL } from '../lib/format';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import { useTheme } from '../lib/theme';
import { Icon } from '../ui/Icon';
import { openLink } from '../ui/Markdown';
import { Button, Checkbox, Field, H1, Input, LinkText, Loading, Logo, Muted, PasswordInput, Row, T } from '../ui/kit';

export interface PublicPricing {
  mode: 'self_hosted' | 'saas';
  currency: string;
  lrd_per_usd: number | null;
  trial_days: number;
  annual_factor: number;
  support_email: string | null;
  plans: import('../lib/api').PublicPlan[];
  company: { name: string | null; address: string | null; email: string | null };
  terms_version: string;
}

export const usePublicPricing = () => useApi<PublicPricing>('/public/plans');

export const TAGLINE = 'Work moves forward together.';

export function AuthFrame({ title, subtitle, children, showServer = true }: { title: string; subtitle?: ReactNode; children: ReactNode; showServer?: boolean }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 20, paddingTop: insets.top + 36, paddingBottom: insets.bottom + 24, gap: 18 }} keyboardShouldPersistTaps="handled">
        <View style={{ alignItems: 'center', marginBottom: 6 }}>
          <Logo height={40} />
        </View>
        <View style={{ backgroundColor: c.surface, borderRadius: 20, padding: 20, gap: 16, borderWidth: 1, borderColor: c.line, maxWidth: 480, width: '100%', alignSelf: 'center' }}>
          <View style={{ gap: 6 }}>
            <H1>{title}</H1>
            {subtitle ? typeof subtitle === 'string' ? <Muted size={15}>{subtitle}</Muted> : subtitle : null}
          </View>
          {children}
        </View>
        <View style={{ flex: 1 }} />
        <Muted style={{ textAlign: 'center' }}>{TAGLINE}</Muted>
        {showServer && <ServerLine />}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Which Küü server the app talks to, with a way to change it. */
function ServerLine() {
  const host = session.server.replace(/^https?:\/\//, '');
  return (
    <Row gap={6} style={{ justifyContent: 'center' }}>
      <Muted size={12}>Server: {host}</Muted>
      <LinkText size={12} onPress={() => router.push('/server')}>
        Use a different server
      </LinkText>
    </Row>
  );
}

export function FormError({ children }: { children: string }) {
  const { c } = useTheme();
  if (!children) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 8, padding: 12, borderRadius: 11, backgroundColor: c.redSoft, borderWidth: 1, borderColor: c.redLine }} accessibilityRole="alert" accessibilityLiveRegion="assertive">
      <Icon name="alert" size={16} color={c.red} />
      <T size={14} tone="red" style={{ flex: 1 }}>
        {children}
      </T>
    </View>
  );
}

const base64url = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bytesToBase64 = (bytes: Uint8Array) => {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return globalThis.btoa(s);
};

/**
 * Single sign-on in the system browser (RFC 8252): the server sends the browser back to
 * kuu://sso with a one-time code, which only this app can redeem with its PKCE verifier.
 */
async function signInWithSso(email: string) {
  const verifier = base64url(bytesToBase64(Crypto.getRandomBytes(32)));
  const challenge = base64url(await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 }));
  const start = `${session.server}/api/auth/sso/start?email=${encodeURIComponent(email)}&client=mobile&challenge=${challenge}`;
  const result = await WebBrowser.openAuthSessionAsync(start, 'kuu://sso');
  if (result.type !== 'success') return null;
  const back = new URL(result.url);
  const error = back.searchParams.get('error');
  if (error) throw new Error(error);
  const code = back.searchParams.get('code');
  if (!code) throw new Error('Sign-in did not finish. Please try again.');
  await api.post('/auth/mobile/exchange', { code, verifier });
  return api.get<Me>('/me');
}

export function Login() {
  const { setMe } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState('');
  const [ssoMode, setSsoMode] = useState(false);
  const { data: pricing } = usePublicPricing();
  const startSso = async () => {
    setError('');
    if (!email) return setError('Enter your work email first');
    try {
      const found = await api.get<{ sso: boolean }>(`/auth/sso/discover?email=${encodeURIComponent(email.trim())}`);
      if (!found.sso) return setError('Single sign-on is not set up for this email domain. Sign in with your password instead.');
      const me = await signInWithSso(email.trim());
      if (me) setMe(me);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const submit = async () => {
    setError('');
    try {
      setMe(await api.post<Me>('/auth/login', { email: email.trim(), password, code: needCode ? code : undefined }));
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.details?.code === 'mfa_required') setNeedCode(true);
      if (apiErr.details?.code === 'sso_required') setSsoMode(true);
      setError(apiErr.details?.code === 'mfa_required' && !needCode ? '' : apiErr.message);
    }
  };
  return (
    <AuthFrame title="Welcome back" subtitle="Sign in to your workspace.">
      <FormError>{error}</FormError>
      <Field label="Work email">
        <Input value={email} onChangeText={setEmail} autoComplete="email" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} textContentType="username" returnKeyType="next" />
      </Field>
      {!ssoMode && (
        <Field label="Password">
          <PasswordInput value={password} onChangeText={setPassword} autoComplete="current-password" textContentType="password" returnKeyType="go" onSubmitEditing={submit} />
        </Field>
      )}
      {needCode && (
        <Field label="Authenticator code" hint="Open your authenticator app and enter the 6-digit code.">
          <Input value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" maxLength={6} autoFocus onSubmitEditing={submit} />
        </Field>
      )}
      {ssoMode ? <Button title="Continue with single sign-on" variant="primary" full onPress={startSso} /> : <Button title="Sign in" variant="primary" full onPress={submit} disabled={!email || !password} />}
      <Row style={{ justifyContent: 'space-between' }}>
        <LinkText
          onPress={() => {
            setSsoMode(!ssoMode);
            setError('');
          }}
        >
          {ssoMode ? 'Use a password instead' : 'Sign in with SSO'}
        </LinkText>
        <LinkText onPress={() => router.push('/forgot-password')}>Forgot password?</LinkText>
      </Row>
      <Row gap={4} wrap style={{ justifyContent: 'center' }}>
        <Muted size={14}>New to Küü?</Muted>
        <LinkText onPress={() => router.push('/register')}>Create a workspace</LinkText>
        {pricing?.mode === 'saas' && (
          <>
            <Muted size={14}>·</Muted>
            <LinkText onPress={() => router.push('/pricing')}>Pricing</LinkText>
          </>
        )}
      </Row>
    </AuthFrame>
  );
}

function TermsCheckbox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const legal = (path: string) => openLink(`${session.server}${path}`);
  return (
    <Checkbox
      checked={checked}
      onChange={onChange}
      label={
        <T size={14} style={{ flex: 1 }}>
          I agree to the{' '}
          <T size={14} tone="accent" onPress={() => legal('/terms')}>
            Terms of Service
          </T>{' '}
          and{' '}
          <T size={14} tone="accent" onPress={() => legal('/privacy')}>
            Privacy Policy
          </T>
          .
        </T>
      }
    />
  );
}

export function Register() {
  const { setMe } = useSession();
  const [form, setForm] = useState({ name: '', email: '', password: '', workspaceName: '', acceptTerms: false });
  const { data: pricing } = usePublicPricing();
  const [error, setError] = useState('');
  const set = (k: keyof typeof form) => (v: string) => setForm({ ...form, [k]: v });
  const submit = async () => {
    setError('');
    try {
      setMe(await api.post<Me>('/auth/register', { ...form, email: form.email.trim() }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const saas = pricing?.mode === 'saas';
  return (
    <AuthFrame
      title="Create your workspace"
      subtitle={saas ? `Start a ${pricing!.trial_days}-day free trial of Organization — no payment needed. Afterwards, keep a free plan or choose a plan.` : 'You will be the workspace owner. Invite your team next.'}
    >
      <FormError>{error}</FormError>
      <Field label="Your name">
        <Input value={form.name} onChangeText={set('name')} autoComplete="name" textContentType="name" />
      </Field>
      <Field label="Work email">
        <Input value={form.email} onChangeText={set('email')} autoComplete="email" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} />
      </Field>
      <Field label="Password" hint="At least 8 characters.">
        <PasswordInput value={form.password} onChangeText={set('password')} autoComplete="new-password" textContentType="newPassword" />
      </Field>
      <Field label="Workspace name">
        <Input value={form.workspaceName} onChangeText={set('workspaceName')} placeholder="e.g. Acme Studio" />
      </Field>
      {saas && <TermsCheckbox checked={form.acceptTerms} onChange={(v) => setForm({ ...form, acceptTerms: v })} />}
      <Button
        title="Create workspace"
        variant="primary"
        full
        onPress={submit}
        disabled={!form.name || !form.email || form.password.length < 8 || form.workspaceName.trim().length < 2 || (saas && !form.acceptTerms)}
      />
      <Row gap={4} style={{ justifyContent: 'center' }}>
        <Muted size={14}>Already have an account?</Muted>
        <LinkText onPress={() => router.replace('/login')}>Sign in</LinkText>
      </Row>
    </AuthFrame>
  );
}

export function AcceptInvite() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { setMe, me } = useSession();
  const { data: invite, error: loadError } = useApi<{ email: string; role: string; workspace_name: string; inviter_name: string; existing_account: boolean }>(`/invitations/${token}`);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [error, setError] = useState('');
  const { data: pricing } = usePublicPricing();
  if (loadError)
    return (
      <AuthFrame title="Invitation unavailable" subtitle={loadError.message}>
        <Button title={me ? 'Go home' : 'Go to sign in'} full onPress={() => router.replace(me ? '/' : '/login')} />
      </AuthFrame>
    );
  if (!invite) return <Loading />;
  const submit = async () => {
    setError('');
    try {
      setMe(await api.post<Me>(`/invitations/${token}/accept`, { name: invite.existing_account ? undefined : name, password, acceptTerms }));
      router.replace('/');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <AuthFrame title={`Join ${invite.workspace_name}`} subtitle={`${invite.inviter_name} invited ${invite.email} as ${ROLE_LABEL[invite.role]?.toLowerCase()}.`}>
      <FormError>{error}</FormError>
      {!invite.existing_account && (
        <Field label="Your name">
          <Input value={name} onChangeText={setName} autoFocus autoComplete="name" />
        </Field>
      )}
      <Field label={invite.existing_account ? 'Your Küü password' : 'Choose a password'} hint={invite.existing_account ? undefined : 'At least 8 characters.'}>
        <PasswordInput value={password} onChangeText={setPassword} autoComplete={invite.existing_account ? 'current-password' : 'new-password'} />
      </Field>
      {!invite.existing_account && pricing?.mode === 'saas' && <TermsCheckbox checked={acceptTerms} onChange={setAcceptTerms} />}
      <Button title="Accept invitation" variant="primary" full onPress={submit} disabled={!password || (!invite.existing_account && !name)} />
    </AuthFrame>
  );
}

export function MfaSetupBody({ onDone }: { onDone?: () => void }) {
  const { c } = useTheme();
  const { setMe } = useSession();
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
  const confirmCode = async () => {
    try {
      setMe(await api.post<Me>('/me/mfa/enable', { code }));
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <View style={{ gap: 14 }}>
      <FormError>{error}</FormError>
      {!secret ? (
        <Button title="Set up authenticator app" variant="primary" full onPress={begin} />
      ) : (
        <>
          <T>1. Open an authenticator app (1Password, Google Authenticator, Authy…) and add an account using this setup key:</T>
          <View style={{ backgroundColor: c.sunken, borderRadius: 10, padding: 12 }}>
            <T weight="bold" selectable style={{ letterSpacing: 1.5, textAlign: 'center', fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) }}>
              {secret.secret.match(/.{1,4}/g)!.join(' ')}
            </T>
          </View>
          <LinkText onPress={() => openLink(secret.otpauth_url)}>Or open it in an authenticator on this phone</LinkText>
          <T>2. Enter the 6-digit code it shows.</T>
          <Field label="Code">
            <Input value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} autoFocus textContentType="oneTimeCode" />
          </Field>
          <Button title="Turn on multifactor authentication" variant="primary" full onPress={confirmCode} disabled={code.length !== 6} />
        </>
      )}
    </View>
  );
}

export function MfaRequired() {
  const { logout } = useSession();
  return (
    <AuthFrame title="Secure your account" subtitle="Your workspace requires multifactor authentication before you continue." showServer={false}>
      <MfaSetupBody />
      <View style={{ alignItems: 'center' }}>
        <LinkText onPress={logout}>Sign out</LinkText>
      </View>
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
        <>
          <T>If an account exists for {email}, a reset link is on its way. It works for one hour.</T>
          <Button title="Back to sign in" full onPress={() => router.replace('/login')} />
        </>
      ) : (
        <>
          <FormError>{error}</FormError>
          <Field label="Work email">
            <Input value={email} onChangeText={setEmail} autoFocus keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
          </Field>
          <Button
            title="Email me a reset link"
            variant="primary"
            full
            disabled={!email}
            onPress={async () => {
              try {
                await api.post('/auth/forgot', { email: email.trim() });
                setSent(true);
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          />
          <View style={{ alignItems: 'center' }}>
            <LinkText onPress={() => router.back()}>Back to sign in</LinkText>
          </View>
        </>
      )}
    </AuthFrame>
  );
}

export function ResetPassword() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  return (
    <AuthFrame title="Choose a new password">
      {done ? (
        <>
          <T>Your password was changed and you were signed out everywhere.</T>
          <Button title="Sign in" variant="primary" full onPress={() => router.replace('/login')} />
        </>
      ) : (
        <>
          <FormError>{error}</FormError>
          <Field label="New password" hint="At least 8 characters.">
            <PasswordInput value={password} onChangeText={setPassword} autoFocus autoComplete="new-password" />
          </Field>
          <Field label="Repeat new password">
            <PasswordInput value={confirmPw} onChangeText={setConfirmPw} autoComplete="new-password" />
          </Field>
          <Button
            title="Change password"
            variant="primary"
            full
            disabled={password.length < 8}
            onPress={async () => {
              if (password !== confirmPw) return setError('The passwords do not match');
              try {
                await api.post('/auth/reset', { token, password });
                setDone(true);
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          />
        </>
      )}
    </AuthFrame>
  );
}

export function VerifyEmail() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { me, refresh } = useSession();
  const [state, setState] = useState<'idle' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  useEffect(() => {
    api
      .post('/auth/verify-email', { token })
      .then(async () => {
        setState('done');
        await refresh();
      })
      .catch((e: Error) => {
        setMessage(e.message);
        setState('error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  if (state === 'idle') return <Loading />;
  return (
    <AuthFrame title={state === 'done' ? 'Email confirmed' : 'Link not valid'} subtitle={state === 'done' ? 'Thanks — your email address is confirmed.' : message} showServer={false}>
      <Button title="Continue" variant="primary" full onPress={() => router.replace(me ? '/' : '/login')} />
    </AuthFrame>
  );
}

/** Choose which Küü server to sign in to: the hosted service, or your organisation's own. */
export function ServerPicker() {
  const [url, setUrl] = useState(session.server === DEFAULT_SERVER ? '' : session.server);
  const [error, setError] = useState('');
  const save = async (value: string) => {
    setError('');
    try {
      const target = value.trim() ? normaliseServer(value) : DEFAULT_SERVER;
      const res = await fetch(`${target}/api/health`).catch(() => null);
      if (!res || !res.ok) throw new Error(`Can't reach a Küü server at ${target.replace(/^https?:\/\//, '')}. Check the address and your connection.`);
      await session.setServer(target);
      await session.setToken(null);
      router.replace('/login');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <AuthFrame title="Choose your server" subtitle="Use the hosted Küü service, or enter the address your organisation gave you." showServer={false}>
      <FormError>{error}</FormError>
      <Field label="Server address" hint={`Leave empty for the hosted service (${DEFAULT_SERVER.replace(/^https?:\/\//, '')}).`}>
        <Input value={url} onChangeText={setUrl} placeholder="kuu.yourcompany.com" keyboardType="url" autoCapitalize="none" autoCorrect={false} autoFocus />
      </Field>
      <Button title="Continue" variant="primary" full onPress={() => save(url)} />
      {session.server !== DEFAULT_SERVER && <Button title="Use the hosted service" full onPress={() => save('')} />}
      <View style={{ alignItems: 'center' }}>
        <LinkText onPress={() => router.back()}>Cancel</LinkText>
      </View>
    </AuthFrame>
  );
}
