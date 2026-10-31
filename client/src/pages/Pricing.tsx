import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type PublicPlan } from '../api';
import { Icon } from '../components/Icon';
import { PlanAllowances, PlanComparison, PlanPrice, PlanUnlocks, annualLine, contactHref, largestTeam, lrd, memberAllowance, monthsFreeYearly, projectAllowance } from '../components/Plan';
import { allowanceBytes } from '../format';
import { Loading } from '@/components/kit';
import { useApi } from '../hooks';
import { useSession } from '../session';
import { PublicPage } from '../components/Public';
import { Logo } from '../components/Logo';
import { buttonVariants } from '@/components/ui/button';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

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

/** Public pricing page, reachable signed in or out. Every number on it comes from the plan catalog. */
export function Pricing() {
  const { me } = useSession();
  const { data } = usePublicPricing();
  if (!data) return <Loading />;
  const plan = (id: string) => data.plans.find((p) => p.id === id);
  const free = plan('free');
  const freeSummary = free ? `${memberAllowance(free)}, ${allowanceBytes(free.storage_bytes)} of storage and ${projectAllowance(free).toLowerCase()}` : '';
  const monthsFree = monthsFreeYearly(data.annual_factor);
  const mail = (email: string) => (
    <a className="text-primary underline underline-offset-2" href={`mailto:${email}`}>
      {email}
    </a>
  );
  const faq: { q: string; a: ReactNode }[] = [
    {
      q: 'What happens when the trial ends?',
      a: `For ${data.trial_days} days a new workspace has everything in Organization. Then it moves to the Free plan unless you choose a paid plan. Nothing is deleted. If you have more than Free includes (${freeSummary}), everything stays available to open, download, export, archive and delete — you just can't add more of that until you reduce it or upgrade.`,
    },
    {
      q: 'What happens if we go over a limit?',
      a: 'Nothing is deleted and nobody loses access. Only actions that would add more of that resource are paused: inviting more members, creating or restoring projects, or uploading files. Remove members you no longer need, archive finished projects, delete old files, or upgrade — everything works normally again once you’re within the allowance.',
    },
    {
      q: 'How does storage work?',
      a: 'Storage is shared by the whole workspace, not given to each person. Every uploaded file and its earlier versions count, as do saved meeting recordings — including files in archived projects. Admins see usage under Administration → Billing, and everyone sees a warning near the limit before uploads stop.',
    },
    {
      q: 'What is an active project?',
      a: 'Any project that isn’t archived. Archiving a finished project frees its place; its tasks, messages and files stay available, and you can restore it when there’s room.',
    },
    {
      q: 'Is the price per person?',
      a: "No. Each plan is one flat monthly price for the whole workspace, up to its member limit. Guests (clients and partners you share specific channels or projects with) don't count toward the limit; guest access is part of Team and above.",
    },
    {
      q: 'How does yearly billing work?',
      a: `Pay for 12 months at once and get ${monthsFree} month${monthsFree === 1 ? '' : 's'} free: the year costs ${Math.round(data.annual_factor * 12)} times the monthly price, charged once. You can also pay for 1, 3 or 6 months at the monthly price.`,
    },
    {
      q: 'How do I pay?',
      a: 'An admin chooses a plan under Administration → Billing, pays by mobile money or bank transfer, and enters the transaction ID. We confirm it and your plan starts — usually within one business day.',
    },
    {
      q: 'We already use Küü. Does this change our plan?',
      a: 'No. These allowances apply to workspaces created from November 2026. Existing workspaces, and anything you’ve already paid for, keep their current allowances.',
    },
    {
      q: `We have more than ${largestTeam(data.plans)} people.`,
      a: (
        <>
          Larger organisations get a custom quote based on usage, onboarding and support needs.
          {data.support_email ? <> Email {mail(data.support_email)} to talk it through.</> : ' Contact us to talk it through.'}
        </>
      ),
    },
    { q: 'Can I leave at any time?', a: 'Yes. Export your data whenever you like, and owners can delete the workspace permanently from Administration → Workspace.' },
  ];
  const body = (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-10 md:px-8">
      <section className="mx-auto flex max-w-3xl flex-col items-center gap-3 text-center">
        <p className="text-xs font-semibold tracking-wide text-primary uppercase">Pricing</p>
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-balance md:text-4xl">Everything your team needs, one simple price</h1>
        <p className="text-muted-foreground text-pretty">
          Chat, projects, knowledge and meetings in one place. One flat price per workspace, not per person. Try Küü free with {freeSummary}, and pay monthly or yearly by mobile money or
          bank transfer when your team is ready for more.
        </p>
        <Badge variant="brand" className="h-auto max-w-full gap-1.5 rounded-full px-3 py-1 text-center text-xs whitespace-normal">
          <Icon name="spark" size={13} className="shrink-0" /> Every new workspace gets a {data.trial_days}-day Organization trial — no payment needed
        </Badge>
      </section>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {data.plans
          .filter((p) => p.price != null)
          .map((p) => (
            <Card key={p.id} className={cn('relative', p.id === 'team' && 'ring-2 ring-primary')}>
              <CardHeader className="gap-2">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-lg">{p.name}</CardTitle>
                  {p.id === 'team' && <Badge>Most popular</Badge>}
                  {p.id === 'organization' && <Badge variant="secondary">Includes AI</Badge>}
                </div>
                <CardDescription className="text-sm text-foreground/80">{p.tagline}</CardDescription>
                <PlanPrice plan={p} />
                <p className="text-xs text-muted-foreground">
                  {p.price ? (
                    <>
                      {annualLine(p, data.annual_factor)}
                      {data.lrd_per_usd ? ` · ${lrd(p.price, data.lrd_per_usd)} a month` : ''}
                    </>
                  ) : (
                    'No time limit and no card needed'
                  )}
                </p>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-4">
                <PlanAllowances plan={p} />
                <PlanUnlocks plan={p} plans={data.plans} />
              </CardContent>
              {!me && (
                <CardFooter>
                  <Link to="/register" className={buttonVariants({ variant: p.id === 'team' ? 'default' : 'outline', className: 'w-full' })}>
                    {p.price ? `Start ${data.trial_days}-day trial` : 'Get started free'}
                  </Link>
                </CardFooter>
              )}
            </Card>
          ))}
      </div>
      {plan('enterprise') && (
        <Card size="sm">
          <CardContent className="flex flex-wrap items-center gap-3">
            <div className="flex min-w-0 flex-1 basis-64 flex-col">
              <strong className="font-heading text-base font-semibold">Enterprise</strong>
              <span className="text-sm text-muted-foreground">{plan('enterprise')!.tagline}</span>
            </div>
            {contactHref(data.support_email, 'Enterprise') && (
              <a href={contactHref(data.support_email, 'Enterprise')!} className={buttonVariants({ variant: 'outline' })}>
                Contact us
              </a>
            )}
          </CardContent>
        </Card>
      )}
      <section className="flex flex-col gap-3" aria-labelledby="compare-title">
        <h2 id="compare-title" className="font-heading text-xl font-semibold">
          Compare plans
        </h2>
        <PlanComparison plans={data.plans} />
      </section>
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        <h2 className="font-heading text-xl font-semibold">Questions</h2>
        <Accordion>
          {faq.map((f) => (
            <AccordionItem key={f.q} value={f.q}>
              <AccordionTrigger>{f.q}</AccordionTrigger>
              <AccordionContent>
                <p className="text-muted-foreground">{f.a}</p>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
        {data.support_email && <p className="text-sm text-muted-foreground">More questions? Email {mail(data.support_email)}.</p>}
      </section>
    </div>
  );
  return me ? body : <PublicPage title="Pricing · Küü">{body}</PublicPage>;
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
    <div className="flex min-h-svh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm text-center">
        <CardHeader className="items-center justify-items-center gap-4">
          <Logo height={34} />
          {state === 'done' && (
            <CardTitle className="flex items-center justify-center gap-2 text-xl">
              <Icon name="check" size={22} className="text-success" /> Email confirmed
            </CardTitle>
          )}
          {state !== 'working' && state !== 'done' && <CardTitle className="text-xl">Link not valid</CardTitle>}
          {state === 'done' && <CardDescription>Thanks! You can now invite your team, use AI features and choose a plan.</CardDescription>}
          {state !== 'working' && state !== 'done' && <CardDescription>{state}</CardDescription>}
        </CardHeader>
        <CardContent>{state === 'working' && <Loading label="Confirming" className="min-h-20" />}</CardContent>
        <CardFooter>
          <Link to="/" className={buttonVariants({ className: 'w-full' })}>
            {me ? 'Back to Küü' : 'Sign in'}
          </Link>
        </CardFooter>
      </Card>
    </div>
  );
}
