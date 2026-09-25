import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { lrd, usd } from '../components/Plan';
import { PublicPage } from '../components/Public';
import { usePublicPricing } from './Pricing';

const FEATURES: { icon: string; title: string; text: string }[] = [
  { icon: 'chat', title: 'Channels and direct messages', text: 'Team, project and private channels, threads, mentions and announcements that people must acknowledge. Mark a message urgent when it really is.' },
  { icon: 'task', title: 'Tasks with one clear owner', text: 'Turn any message into a task. Every task has an owner, a due date and a status, so nothing falls between people.' },
  { icon: 'folder', title: 'Projects, timelines and workload', text: 'Boards, milestones, a timeline you can drag, and a workload view that shows who is overloaded before deadlines slip.' },
  { icon: 'book', title: 'Knowledge that stays current', text: 'Policies, how-tos and files in one searchable place, with owners, approvals, review dates and full version history.' },
  { icon: 'video', title: 'Meetings that end with decisions', text: 'Agendas, notes, decisions and follow-up tasks captured in the meeting, and a summary sent to everyone afterwards.' },
  { icon: 'spark', title: 'Ask Küü', text: 'Ask a question and get an answer with links to the messages, pages and decisions it came from — only from what you can already see.' },
  { icon: 'refresh', title: 'Automations and reminders', text: 'Hand work to the right person when a task moves, get reminded before things are due, and schedule messages for later.' },
  { icon: 'shield', title: 'Secure by default', text: 'Two-step sign-in, single sign-on, detailed permissions, guest expiry and an audit log of every important action.' },
];

const FAQ: [string, string][] = [
  ['Do I need a card to start?', 'No. Create a workspace and you get the Business plan free for 30 days. Afterwards you can stay on the Free plan for as long as you like, or choose a paid plan.'],
  ['How do we pay?', 'An admin chooses a plan in the app, pays with Orange Money, MTN Mobile Money or bank transfer, and enters the transaction ID. Your plan starts as soon as the payment is confirmed.'],
  ['Does it work on phones and slow connections?', 'Yes. Küü works in any modern browser and installs on Android and iPhone home screens like an app. Pages are kept small, and recently viewed information stays readable when your connection drops.'],
  ['Who owns our data?', 'You do. Admins can export everything at any time, and owners can delete the workspace permanently. See the Privacy Policy for the details.'],
  ['Can we invite people from outside our company?', 'Yes. On paid plans, guests see only the channels and projects you share with them, and their access expires automatically. Guests are free.'],
  ['What happens if we stop paying?', 'After a short grace period your workspace moves to the Free plan. Nothing is deleted; paid features pause until you pay again.'],
];

/** Screenshot-like illustration of the app, drawn with HTML so it stays sharp and light. */
function AppPreview() {
  return (
    <div className="app-preview" aria-hidden="true">
      <div className="ap-side">
        <img className="ap-logo" src="/favicon.svg" alt="" />
        <i className="active" />
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="ap-main">
        <div className="ap-top">
          <b># launch-team</b>
          <span className="ap-pill">4 online</span>
        </div>
        <div className="ap-msg">
          <span className="ap-av a">MK</span>
          <div>
            <b>Musu</b> <small>9:14</small>
            <p>Supplier confirmed delivery for Friday. Who can check the stock list?</p>
            <span className="ap-chip">
              <Icon name="task" size={12} /> Task · Check stock list · Jallah · due Thu
            </span>
          </div>
        </div>
        <div className="ap-msg">
          <span className="ap-av b">JT</span>
          <div>
            <b>Jallah</b> <small>9:16</small>
            <p>On it — I’ll post the list in the project by Thursday.</p>
          </div>
        </div>
        <div className="ap-msg">
          <span className="ap-av c">AD</span>
          <div>
            <b>Aminata</b> <small>9:20</small>
            <p>Decision: we open the Paynesville branch on the 1st. 🎉</p>
            <span className="ap-chip green">
              <Icon name="gavel" size={12} /> Decision recorded
            </span>
          </div>
        </div>
      </div>
      <div className="ap-panel">
        <b>Today</b>
        <div className="ap-task done">Send price list to Ecobank</div>
        <div className="ap-task">Check stock list</div>
        <div className="ap-task late">Renew business registration</div>
        <b>Next meeting</b>
        <div className="ap-meet">Weekly review · 10:00</div>
      </div>
    </div>
  );
}

/** Public home page for the hosted service. */
export function Landing() {
  const { data } = usePublicPricing();
  const standard = data?.plans.find((p) => p.id === 'standard');
  const business = data?.plans.find((p) => p.id === 'business');
  return (
    <PublicPage title="Küü — work moves forward together">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">WORK MOVES FORWARD TOGETHER · MADE FOR LIBERIA</p>
          <h1>Stop chasing work across WhatsApp, email and spreadsheets.</h1>
          <p className="hero-sub">
            Küü brings your team’s conversations, tasks, projects, documents and meetings into one calm place — so everyone knows what matters today, who owns
            it, and what was decided.
          </p>
          <div className="row-gap wrap">
            <Link className="btn primary lg" to="/register">
              Start your free 30-day trial
            </Link>
            <Link className="btn lg" to="/pricing">
              See pricing
            </Link>
          </div>
          <ul className="hero-points">
            <li>
              <Icon name="check" size={15} /> Free plan forever for up to 10 people
            </li>
            <li>
              <Icon name="check" size={15} /> Pay with Orange Money, MTN MoMo or bank transfer
            </li>
            <li>
              <Icon name="check" size={15} /> Works on phones and slow connections
            </li>
          </ul>
        </div>
        <AppPreview />
      </section>

      <section className="replace-strip" aria-label="What Küü replaces">
        <p className="muted">One workspace instead of scattered tools</p>
        <div>
          {['Group chats', 'Email threads', 'Task spreadsheets', 'Shared folders', 'Meeting notes'].map((t) => (
            <span key={t}>
              <Icon name="x" size={13} /> {t}
            </span>
          ))}
        </div>
      </section>

      <section id="features" className="public-section">
        <p className="eyebrow center">FEATURES</p>
        <h2 className="center">Everything a busy team needs, in one place</h2>
        <div className="feature-grid">
          {FEATURES.map((f) => (
            <div key={f.title} className="feature-card">
              <span className="feature-icon">
                <Icon name={f.icon} size={20} />
              </span>
              <h3>{f.title}</h3>
              <p className="muted">{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="public-section local">
        <div>
          <p className="eyebrow">BUILT FOR HOW WE WORK HERE</p>
          <h2>Priced and designed for Liberian teams</h2>
          <p className="muted">
            Global tools are priced for Silicon Valley budgets and need card payments many teams here can’t make. Küü costs a fraction of what they charge, you pay the way
            you already pay for everything else, and it stays usable when the network doesn’t.
          </p>
        </div>
        <div className="local-grid">
          <div className="card">
            <Icon name="flag" size={20} />
            <h3>Mobile money payments</h3>
            <p className="muted">Orange Money, MTN Mobile Money or bank transfer. Monthly or yearly, in US dollars{data?.lrd_per_usd ? ', with Liberian-dollar amounts shown' : ''}.</p>
          </div>
          <div className="card">
            <Icon name="download" size={20} />
            <h3>Light on data</h3>
            <p className="muted">Compressed pages, an installable app for your phone, and recently viewed information that stays readable offline.</p>
          </div>
          <div className="card">
            <Icon name="users" size={20} />
            <h3>From 3 people to 300</h3>
            <p className="muted">Start free with a small team. Add departments, guests from partner organisations, single sign-on and more as you grow.</p>
          </div>
        </div>
      </section>

      <section className="public-section">
        <p className="eyebrow center">HOW IT WORKS</p>
        <h2 className="center">Up and running in an afternoon</h2>
        <ol className="how-steps">
          <li>
            <b>1</b>
            <h3>Create your workspace</h3>
            <p className="muted">Sign up with your email. You get every Business feature free for 30 days.</p>
          </li>
          <li>
            <b>2</b>
            <h3>Invite your team</h3>
            <p className="muted">Send invitations by email. Channels for general news and announcements are ready from the start.</p>
          </li>
          <li>
            <b>3</b>
            <h3>Move one project in</h3>
            <p className="muted">Start with one real project: its chat, tasks and documents. The rest of the team follows once they see it working.</p>
          </li>
        </ol>
      </section>

      {standard && business && (
        <section className="public-section price-teaser">
          <h2 className="center">Simple pricing, per member</h2>
          <div className="teaser-grid">
            <div className="card">
              <h3>Free</h3>
              <p className="plan-price">
                <strong>$0</strong> <span className="muted">forever</span>
              </p>
              <p className="muted">Up to 10 members with chat, tasks, projects, knowledge and meetings.</p>
            </div>
            <div className="card">
              <h3>Standard</h3>
              <p className="plan-price">
                <strong>{usd(standard.price)}</strong> <span className="muted">per member / month</span>
              </p>
              <p className="muted small">{lrd(standard.price, data?.lrd_per_usd)}</p>
              <p className="muted">Unlimited members, timelines, workload, automations, guests and insights.</p>
            </div>
            <div className="card featured">
              <h3>Business</h3>
              <p className="plan-price">
                <strong>{usd(business.price)}</strong> <span className="muted">per member / month</span>
              </p>
              <p className="muted small">{lrd(business.price, data?.lrd_per_usd)}</p>
              <p className="muted">Everything in Standard plus AI, single sign-on and compliance controls.</p>
            </div>
          </div>
          <p className="center">
            <Link to="/pricing">Compare plans in detail →</Link>
          </p>
        </section>
      )}

      <section id="faq" className="public-section pricing-faq">
        <h2>Questions</h2>
        {FAQ.map(([q, a]) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </section>

      <section className="final-cta">
        <h2>Give your team one place to work.</h2>
        <p>Free for 30 days. Free forever for small teams.</p>
        <Link className="btn lg" to="/register">
          Create your workspace
        </Link>
      </section>
    </PublicPage>
  );
}
