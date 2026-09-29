import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Feature, type PublicPlan } from '../api';
import { Icon } from '../components/Icon';
import { FEATURE_ORDER, PlanFeatures, PlanPrice, contactHref, lrd, usd } from '../components/Plan';
import { Loading } from '../components/ui';
import { useApi } from '../hooks';
import { useSession } from '../session';
import { PublicPage } from '../components/Public';
import { Logo } from '../components/Logo';

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
  const perYear = (p: PublicPlan) => (p.price ?? 0) * 12 * data.annual_factor;
  const body = (
    <>
      <section className="pricing-hero">
        <p className="eyebrow">PRICING</p>
        <h1>Everything your team needs, priced for Liberia</h1>
        <p className="muted">
          Chat, projects, knowledge and meetings in one place. One flat price per workspace, not per person. Start with a {data.trial_days}-day free trial of Organization — no payment
          needed — and keep a free plan for up to 5 members forever. Pay monthly or yearly with Orange Money, MTN Mobile Money or bank transfer.
        </p>
      </section>
      <div className="plan-grid">
        {data.plans.map((p) => (
          <div key={p.id} className={`card plan-card ${p.id === 'organization' ? 'featured' : ''}`}>
            {p.id === 'organization' && <span className="plan-badge">Includes AI</span>}
            <h3>{p.name}</h3>
            <PlanPrice plan={p} />
            <p className="muted small">
              {p.price == null
                ? 'Based on usage, onboarding and support needs'
                : p.price
                  ? `${lrd(p.price, data.lrd_per_usd)}${data.lrd_per_usd ? ' · ' : ''}${usd(perYear(p))} a year when paid yearly`
                  : 'Free forever'}
            </p>
            <p className="muted">{p.tagline}</p>
            <PlanFeatures plan={p} all={FEATURE_ORDER as Feature[]} />
            {p.price == null
              ? contactHref(data.support_email, p.name) && (
                  <a className="btn block" href={contactHref(data.support_email, p.name)!}>
                    Contact us
                  </a>
                )
              : !me && (
                  <Link className={`btn block ${p.id === 'organization' ? 'primary' : ''}`} to="/register">
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
          <summary>Is the price per person?</summary>
          <p>
            No. Each plan is one flat monthly price for the whole workspace, up to its member limit. Guests (clients and partners you share specific channels or
            projects with) don't count toward the limit.
          </p>
        </details>
        <details>
          <summary>We have more than 50 people.</summary>
          <p>
            Larger organisations get a custom quote based on usage, onboarding and support needs.
            {data.support_email ? (
              <>
                {' '}
                Email <a href={`mailto:${data.support_email}`}>{data.support_email}</a> to talk it through.
              </>
            ) : (
              ' Contact us to talk it through.'
            )}
          </p>
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
  return me ? <div className="page">{body}</div> : <PublicPage title="Pricing · Küü">{body}</PublicPage>;
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
          <Logo height={34} />
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
          {me ? 'Back to Küü' : 'Sign in'}
        </Link>
      </div>
    </div>
  );
}
