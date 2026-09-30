import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { usd } from '../components/Plan';
import { ProductDemo } from '../components/ProductDemo';
import { PublicPage } from '../components/Public';
import '../landing.css';
import { usePublicPricing } from './Pricing';

const FEATURES: { icon: string; title: string; text: string }[] = [
  { icon: 'chat', title: 'Channels and direct messages', text: 'Team, project and private channels, threads, mentions, polls, voice notes and announcements people must acknowledge.' },
  { icon: 'task', title: 'Tasks with one clear owner', text: 'Turn any message into a task. Every task has an owner, a due date and a status, so nothing falls between people.' },
  { icon: 'board', title: 'Projects, timelines and workload', text: 'Boards, tables, calendars and a timeline you can drag, plus a workload view that shows who is overloaded before deadlines slip.' },
  { icon: 'book', title: 'Docs you write together', text: 'Edit pages live with your team. Owners, approvals, review dates and version history keep knowledge current.' },
  { icon: 'video', title: 'Meetings that end with decisions', text: 'Agendas, recordings with live captions, searchable transcripts, decisions and follow-up tasks in one place.' },
  { icon: 'spark', title: 'Ask Küü', text: 'Ask a question and get an answer with links to the messages, pages and decisions it came from — only from what you can see.' },
  { icon: 'chart', title: 'Dashboards and goals', text: 'Charts of the work across projects, goals with key results, and time tracking that shows where the week went.' },
  { icon: 'shield', title: 'Secure by default', text: 'Two-step sign-in, single sign-on, detailed permissions, guest expiry and an audit log of every important action.' },
];

const REPLACES = ['Group chats', 'Email threads', 'Task spreadsheets', 'Shared folders', 'Meeting notes', 'Sticky notes', 'Status calls', 'Lost attachments'];

const HEADLINE_WORDS = ['group chats', 'email threads', 'spreadsheets', 'shared folders', 'sticky notes'];

const FAQ: [string, string][] = [
  ['Do I need a card to start?', 'No. Create a workspace and you get the Organization plan free for 14 days. Afterwards you can stay on the Free plan (up to 5 members) for as long as you like, or choose a paid plan.'],
  ['How do we pay?', 'An admin chooses a plan in the app and pays by mobile money or bank transfer, monthly or yearly. Your plan starts as soon as the payment is confirmed.'],
  ['Does it work on phones and slow connections?', 'Yes. Küü works in any modern browser and installs on Android and iPhone home screens like an app. Pages are kept small, and recently viewed information stays readable when your connection drops.'],
  ['Who owns our data?', 'You do. Admins can export everything at any time, and owners can delete the workspace permanently. See the Privacy Policy for the details.'],
  ['Can we invite people from outside our company?', 'Yes. On the Team plan and above, guests see only the channels and projects you share with them, and their access expires automatically. Guests don’t count toward your member limit.'],
  ['What happens if we stop paying?', 'After a short grace period your workspace moves to the Free plan. Nothing is deleted; paid features pause until you pay again.'],
];

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Fade sections in as they scroll into view. Without JavaScript or with reduced motion, everything is simply visible.
 * `ready` re-scans the page when content that arrives later (the prices) appears.
 */
function useReveal(root: React.RefObject<HTMLElement | null>, ready: unknown) {
  useEffect(() => {
    const el = root.current;
    if (!el || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    el.classList.add('reveal-on');
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('revealed');
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' },
    );
    el.querySelectorAll('[data-reveal]:not(.revealed)').forEach((node) => io.observe(node));
    return () => io.disconnect();
  }, [root, ready]);
}

/** Counts up to `to` the first time it is seen. */
function CountUp({ to, suffix = '' }: { to: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [value, setValue] = useState(reducedMotion() ? to : 0);
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || typeof IntersectionObserver === 'undefined') {
      setValue(to);
      return;
    }
    let frame = 0;
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      io.disconnect();
      const start = performance.now();
      const step = (t: number) => {
        const p = Math.min(1, (t - start) / 1200);
        setValue(Math.round(to * (1 - Math.pow(1 - p, 3))));
        if (p < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [to]);
  return (
    <span ref={ref}>
      {value}
      {suffix}
    </span>
  );
}

/** The scattered tools Küü replaces, crossed out in turn. */
function RotatingWord() {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (reducedMotion()) return;
    const timer = window.setInterval(() => setI((n) => (n + 1) % HEADLINE_WORDS.length), 2600);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="rotator" aria-hidden="true">
      <span key={i} className="rotator-word">
        {HEADLINE_WORDS[i]}
      </span>
    </span>
  );
}

/** Soft spotlight that follows the pointer across a card. */
const spotlight = (e: React.PointerEvent<HTMLElement>) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>('.spot');
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty('--mx', `${e.clientX - r.left}px`);
  card.style.setProperty('--my', `${e.clientY - r.top}px`);
};

const stagger = (i: number) => ({ '--i': i }) as CSSProperties;

/** Public home page for the hosted service. */
export function Landing() {
  const { data } = usePublicPricing();
  const root = useRef<HTMLDivElement>(null);
  useReveal(root, data);
  const trialDays = data?.trial_days ?? 14;
  const teaser = (['starter', 'team', 'organization'] as const).map((id) => data?.plans.find((p) => p.id === id));
  return (
    <PublicPage title="Küü — work moves forward together">
      <div className="landing" ref={root}>
        <section className="hero2">
          <div className="hero-glow" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <p className="hero-badge">
            <span>New</span> Live co-editing, whiteboards and meeting transcripts
          </p>
          <h1>
            Stop chasing work across <RotatingWord />
            <span className="sr-only">group chats, email threads and spreadsheets</span>
          </h1>
          <p className="hero-sub">
            Küü brings your team’s conversations, tasks, projects, documents and meetings into one calm place — so everyone knows what matters today, who owns
            it, and what was decided.
          </p>
          <div className="hero-ctas">
            <Link className="btn primary lg shine" to="/register">
              Start your free {trialDays}-day trial <Icon name="arrow" size={16} />
            </Link>
            <a className="btn lg ghost-lg" href="#tour">
              <Icon name="play" size={15} /> See it in action
            </a>
          </div>
          <ul className="hero-points">
            <li>
              <Icon name="check" size={15} /> Free forever for up to 5 people
            </li>
            <li>
              <Icon name="check" size={15} /> No card needed
            </li>
            <li>
              <Icon name="check" size={15} /> Works on phones and slow connections
            </li>
          </ul>
        </section>

        <section id="tour" className="tour" data-reveal>
          <ProductDemo />
        </section>

        <section className="marquee" aria-label="What Küü replaces">
          <p className="muted">One workspace instead of scattered tools</p>
          <div className="marquee-track">
            <div className="marquee-row">
              {[...REPLACES, ...REPLACES].map((t, i) => (
                <span key={i} aria-hidden={i >= REPLACES.length}>
                  <Icon name="x" size={13} /> {t}
                </span>
              ))}
            </div>
          </div>
        </section>

        <section className="stats" data-reveal>
          <div>
            <b>
              <CountUp to={6} />
            </b>
            <span>tools replaced by one workspace</span>
          </div>
          <div>
            <b>
              <CountUp to={trialDays} />
            </b>
            <span>day free trial of every feature</span>
          </div>
          <div>
            <b>
              <CountUp to={5} />
            </b>
            <span>people free, forever</span>
          </div>
          <div>
            <b>
              <CountUp to={1} />
            </b>
            <span>search across chat, tasks, docs and meetings</span>
          </div>
        </section>

        <section id="features" className="public-section">
          <p className="eyebrow center" data-reveal>
            FEATURES
          </p>
          <h2 className="center" data-reveal>
            Everything a busy team needs, in one place
          </h2>
          <div className="feature-grid" onPointerMove={spotlight}>
            {FEATURES.map((f, i) => (
              <div key={f.title} className="feature-card spot" data-reveal style={stagger(i % 4)}>
                <span className="feature-icon">
                  <Icon name={f.icon} size={20} />
                </span>
                <h3>{f.title}</h3>
                <p className="muted">{f.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="public-section why">
          <div data-reveal>
            <p className="eyebrow">MADE FOR REAL-WORLD TEAMS</p>
            <h2>Fast on any phone, fair on any budget</h2>
            <p className="muted">
              Küü costs a fraction of the big global tools, you pay the way you already pay for everything else, and it stays usable when the network doesn’t.
            </p>
          </div>
          <div className="why-grid" onPointerMove={spotlight}>
            {[
              ['download', 'Light on data', 'Compressed pages, an installable app for your phone, and recently viewed information that stays readable offline.'],
              ['send', 'Pay the way you pay', 'Mobile money or bank transfer, monthly or yearly. One flat price per workspace, not per person.'],
              ['users', 'From 3 people to 300', 'Start free with a small team. Add departments, partner guests, single sign-on and more as you grow.'],
            ].map(([icon, title, text], i) => (
              <div key={title} className="card spot" data-reveal style={stagger(i)}>
                <Icon name={icon} size={20} />
                <h3>{title}</h3>
                <p className="muted">{text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="public-section">
          <p className="eyebrow center" data-reveal>
            HOW IT WORKS
          </p>
          <h2 className="center" data-reveal>
            Up and running in an afternoon
          </h2>
          <ol className="how-steps flow" data-reveal>
            {[
              ['Create your workspace', `Sign up with your email. You get every Organization feature free for ${trialDays} days.`],
              ['Invite your team', 'Send invitations by email. Channels for general news and announcements are ready from the start.'],
              ['Move one project in', 'Start with one real project: its chat, tasks and documents. The rest of the team follows once they see it working.'],
            ].map(([title, text], i) => (
              <li key={title} style={stagger(i)}>
                <b>{i + 1}</b>
                <h3>{title}</h3>
                <p className="muted">{text}</p>
              </li>
            ))}
          </ol>
        </section>

        {teaser.every(Boolean) && (
          <section className="public-section price-teaser">
            <h2 className="center" data-reveal>
              One flat price per workspace
            </h2>
            <p className="center muted" data-reveal>
              Free for up to 5 members. New workspaces try every Organization feature free for {trialDays} days.
            </p>
            <div className="teaser-grid" onPointerMove={spotlight}>
              {teaser.map((p, i) => (
                <div key={p!.id} className={`card spot lift ${p!.id === 'team' ? 'featured' : ''}`} data-reveal style={stagger(i)}>
                  <h3>{p!.name}</h3>
                  <p className="plan-price">
                    <strong>{usd(p!.price ?? 0)}</strong> <span className="muted">per workspace / month</span>
                  </p>
                  <p className="muted small">Up to {p!.member_limit} members</p>
                  <p className="muted">{p!.tagline}</p>
                </div>
              ))}
            </div>
            <p className="center">
              More than 50 people? We'll quote for you. <Link to="/pricing">Compare plans in detail →</Link>
            </p>
          </section>
        )}

        <section id="faq" className="public-section pricing-faq faq-anim" data-reveal>
          <h2>Questions</h2>
          {FAQ.map(([q, a]) => (
            <details key={q}>
              <summary>
                {q}
                <Icon name="plus" size={16} />
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </section>

        <section className="final-cta final-anim" data-reveal>
          <div className="cta-orbs" aria-hidden="true">
            <i />
            <i />
          </div>
          <h2>Give your team one place to work.</h2>
          <p>Free for {trialDays} days. Free forever for teams of up to 5.</p>
          <Link className="btn lg shine" to="/register">
            Create your workspace <Icon name="arrow" size={16} />
          </Link>
        </section>
      </div>
    </PublicPage>
  );
}
