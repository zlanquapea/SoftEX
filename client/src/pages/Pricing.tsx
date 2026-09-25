import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Feature, type PublicPlan } from '../api';
import { Icon } from '../components/Icon';
import { FEATURE_ORDER, PlanFeatures, lrd, usd } from '../components/Plan';
import { Loading } from '../components/ui';
import { useApi } from '../hooks';
import { useSession } from '../session';
import { PublicPage } from '../components/Public';

export interface PublicPricing {
  mode: 'self_hosted' | 'saas';
  currency: string;
  lrd_per_usd: number | null;
  trial_days: number;
  annual_factor: number;
  support_email: string | null;
  plans: PublicPlan[];
  company: { name: string | null; address: string | null; email: string | null };
  terms_version: string;
}

export const usePublicPricing = () => useApi<PublicPricing>('/public/plans');

/** Public pricing page, reachable signed in or out. */
export function Pricing() {
  const { me } = useSession();
  const { data } = usePublicPricing();
  if (!data) return <Loading />;
  const perYear = (p: PublicPlan) => p.price * 12 * data.annual_factor;
  const body = (
    <>
      <section className="pricing-hero">
        <p className="eyebrow">PRICING</p>
        <h1>Everything your team needs, priced for Liberia</h1>
        <p className="muted">
          Chat, projects, knowledge and meetings in one place. Start with a {data.trial_days}-day free trial of Business — no payment needed — and keep a free plan forever.
          Pay monthly or yearly with Orange Money, MTN Mobile Money or bank transfer.
        </p>
      </section>
      <div className="plan-grid">
        {data.plans.map((p) => (
          <div key={p.id} className={`card plan-card ${p.id === 'business' ? 'featured' : ''}`}>
            {p.id === 'business' && <span className="plan-badge">Includes AI</span>}
            <h3>{p.name}</h3>
            <p className="plan-price">
              {p.price ? (
                <>
                  <strong>{usd(p.price)}</strong> <span className="muted">per member / month</span>
                </>
              ) : (
                <>
                  <strong>$0</strong> <span className="muted">forever</span>
                </>
              )}
            </p>
            <p className="muted small">
              {p.price ? `${lrd(p.price, data.lrd_per_usd)}${data.lrd_per_usd ? ' · ' : ''}${usd(perYear(p))} per member / year when paid yearly` : 'Free forever'}
            </p>
            <p className="muted">{p.tagline}</p>
            <PlanFeatures plan={p} all={FEATURE_ORDER as Feature[]} />
            {!me && (
              <Link className={`btn block ${p.id === 'business' ? 'primary' : ''}`} to="/register">
                {p.price ? 'Start free trial' : 'Get started free'}
              </Link>
            )}
          </div>
        ))}
      </div>
      <section className="pricing-faq">
        <h2>Questions</h2>
        <details>
          <summary>What happens when the trial ends?</summary>
          <p>Your workspace moves to the Free plan automatically. Nothing is deleted; paid features pause until you choose a plan.</p>
        </details>
        <details>
          <summary>How do I pay?</summary>
          <p>
            An admin chooses a plan under Administration → Billing, pays with Orange Money, MTN Mobile Money or bank transfer, and enters the transaction ID. We confirm it
            and your plan starts — usually within one business day.
          </p>
        </details>
        <details>
          <summary>Who counts as a member?</summary>
          <p>Everyone in your workspace except guests. Guests (clients and partners you share specific channels or projects with) are free on paid plans.</p>
        </details>
        <details>
          <summary>Can I leave at any time?</summary>
          <p>Yes. Export your data whenever you like, and owners can delete the workspace permanently from Administration → Workspace.</p>
        </details>
        {data.support_email && (
          <p className="muted">
            More questions? Email <a href={`mailto:${data.support_email}`}>{data.support_email}</a>.
          </p>
        )}
      </section>
    </>
  );
  return me ? <div className="page">{body}</div> : <PublicPage title="Pricing · SoftEX">{body}</PublicPage>;
}

/** Target of the link in the "confirm your email" message. */
export function VerifyEmail() {
  const { token } = useParams();
  const { me, refresh } = useSession();
  const [state, setState] = useState<'working' | 'done' | string>('working');
  useEffect(() => {
    api
      .post('/auth/verify-email', { token })
      .then(() => {
        setState('done');
        if (me) refresh();
      })
      .catch((e) => setState((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  return (
    <div className="auth">
      <div className="auth-card center">
        <div className="brand dark">
          <span className="brand-mark">S</span>
          <span>SoftEX</span>
        </div>
        {state === 'working' && <Loading label="Confirming" />}
        {state === 'done' && (
          <>
            <h1>
              <Icon name="check" size={22} /> Email confirmed
            </h1>
            <p className="muted">Thanks! You can now invite your team, use AI features and choose a plan.</p>
          </>
        )}
        {state !== 'working' && state !== 'done' && (
          <>
            <h1>Link not valid</h1>
            <p className="muted">{state}</p>
          </>
        )}
        <Link className="btn primary block" to="/">
          {me ? 'Back to SoftEX' : 'Sign in'}
        </Link>
      </div>
    </div>
  );
}
