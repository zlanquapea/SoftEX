import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * A live, self-playing tour of the app for the website: each scene is drawn with
 * HTML and CSS (no video), so it stays sharp, light on data and follows the theme.
 * Scenes advance on their own, pause on hover or when scrolled out of view, and
 * can be picked with the tabs. With reduced motion, every scene shows its final state.
 */

const DURATION = 7000;

const SCENES = [
  { id: 'chat', label: 'Chat', icon: 'chat', title: '# launch-team', caption: 'Turn any message into a task with one clear owner.' },
  { id: 'projects', label: 'Projects', icon: 'board', title: 'Website relaunch', caption: 'Boards, timelines and workload that update themselves.' },
  { id: 'docs', label: 'Docs', icon: 'book', title: 'Onboarding handbook', caption: 'Write together, live, with owners and review dates.' },
  { id: 'meetings', label: 'Meetings', icon: 'video', title: 'Weekly review', caption: 'Record, caption and capture decisions as you talk.' },
  { id: 'ask', label: 'Ask Küü', icon: 'spark', title: 'Ask Küü', caption: 'Answers with sources, drawn only from what you can see.' },
  { id: 'dashboards', label: 'Dashboards', icon: 'chart', title: 'Operations overview', caption: 'Live charts of the work across every project.' },
] as const;

type SceneId = (typeof SCENES)[number]['id'];

const delay = (s: number) => ({ '--d': `${s}s` }) as CSSProperties;

function Avatar({ initials, tone }: { initials: string; tone: string }) {
  return <span className={`dm-av ${tone}`}>{initials}</span>;
}

function Msg({ who, initials, tone, time, at, children }: { who: string; initials: string; tone: string; time: string; at: number; children: ReactNode }) {
  return (
    <div className="dm-msg dm-in" style={delay(at)}>
      <Avatar initials={initials} tone={tone} />
      <div>
        <b>{who}</b> <small>{time}</small>
        <div className="dm-msg-body">{children}</div>
      </div>
    </div>
  );
}

function ChatScene() {
  return (
    <div className="dm-chat">
      <Msg who="Amara Okafor" initials="AO" tone="coral" time="9:14" at={0.2}>
        <p>Supplier confirmed delivery for Friday. Who can check the stock list?</p>
        <span className="dm-chip dm-pop" style={delay(1.9)}>
          <Icon name="task" size={12} /> Task · Check stock list · Kofi · due Thu
        </span>
      </Msg>
      <Msg who="Kofi Mensah" initials="KM" tone="blue" time="9:15" at={1}>
        <p>On it. I’ll post the list in the project by Thursday.</p>
      </Msg>
      <Msg who="Sara Lind" initials="SL" tone="green" time="9:20" at={2.8}>
        <p>Decision: we open the new branch on the 1st 🎉</p>
        <span className="dm-chip green dm-pop" style={delay(3.6)}>
          <Icon name="gavel" size={12} /> Decision recorded
        </span>
      </Msg>
      <div className="dm-reactions dm-pop" style={delay(4.2)}>
        <span>🎉 4</span>
        <span>👍 6</span>
      </div>
      <div className="dm-typing dm-in" style={delay(4.8)}>
        <span className="dm-dots">
          <i />
          <i />
          <i />
        </span>
        Tomás is typing
      </div>
      <div className="dm-toast dm-toast-in" style={delay(2)}>
        <Icon name="check" size={13} /> Task assigned to Kofi
      </div>
    </div>
  );
}

function Card({ title, tone, who, due, className = '', style }: { title: string; tone: string; who: string; due: string; className?: string; style?: CSSProperties }) {
  return (
    <div className={`dm-card ${className}`} style={style}>
      <span className={`dm-label ${tone}`} />
      <p>{title}</p>
      <div className="dm-card-foot">
        <Avatar initials={who} tone={tone} />
        <small>
          <Icon name="clock" size={10} /> {due}
        </small>
      </div>
    </div>
  );
}

function ProjectsScene() {
  return (
    <div className="dm-projects">
      <div className="dm-proj-head">
        <span className="dm-meter">
          <i className="dm-grow-x" />
        </span>
        <small>68% done · on track</small>
      </div>
      <div className="dm-board">
        <div className="dm-col">
          <h5>To do</h5>
          <Card title="Write launch email" tone="blue" who="LA" due="Mon" />
          <Card title="Update pricing page" tone="purple" who="TR" due="Tue" />
        </div>
        <div className="dm-col">
          <h5>In progress</h5>
          <Card title="New product photos" tone="coral" who="AO" due="Wed" />
        </div>
        <div className="dm-col">
          <h5>Done</h5>
          <Card title="Brief the agency" tone="green" who="SL" due="Done" />
          <Card title="Check stock list" tone="gold" who="KM" due="Thu" className="dm-mover" />
        </div>
      </div>
      <div className="dm-timeline">
        {[
          ['Design', 8, 38, 'coral'],
          ['Build', 30, 44, 'blue'],
          ['Launch', 66, 26, 'green'],
        ].map(([name, left, width, tone], i) => (
          <div key={name} className="dm-tl-row">
            <small>{name}</small>
            <span className="dm-tl-track">
              <i className={`dm-tl-bar ${tone} dm-grow-x`} style={{ left: `${left}%`, width: `${width}%`, ...delay(0.4 + i * 0.35) }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DocsScene() {
  return (
    <div className="dm-doc">
      <div className="dm-doc-top">
        <span className="dm-presence">
          <Avatar initials="LA" tone="purple" />
          <Avatar initials="KM" tone="blue" />
        </span>
        <span className="dm-chip green dm-pop" style={delay(4.6)}>
          <Icon name="check" size={11} /> Saved
        </span>
      </div>
      <h4>Welcome to the team 👋</h4>
      <p className="dm-owner">
        Owner: Lina Alvarez · Review every 6 months
      </p>
      <p>
        Your first week is about meeting people and learning how we work. <mark className="dm-mark">Ask questions early</mark> — nobody expects you to
        know everything.
      </p>
      <p className="dm-typed-line">
        <span className="dm-typed" style={delay(0.6)}>
          Day 1: laptop, accounts and a coffee with your buddy.
        </span>
        <span className="dm-caret purple">
          <em>Lina</em>
        </span>
      </p>
      <ul>
        <li>Read the handbook and the security policy</li>
        <li className="dm-in" style={delay(3)}>
          Join <b>#general</b> and <b>#launch-team</b>
          <span className="dm-caret blue static">
            <em>Kofi</em>
          </span>
        </li>
      </ul>
    </div>
  );
}

function MeetingsScene() {
  const captions = [
    ['Sara', 'Sales grew 12% this month, mostly from the new branch.'],
    ['Kofi', 'Stock is ready for Friday’s delivery.'],
    ['Amara', 'Let’s move the budget review to next week.'],
  ];
  return (
    <div className="dm-meeting">
      <div className="dm-meet-main">
        <div className="dm-meet-bar">
          <span className="dm-rec">
            <i /> REC
          </span>
          <small>00:12:48</small>
        </div>
        <div className="dm-tiles">
          {[
            ['SL', 'green', true],
            ['KM', 'blue', false],
            ['AO', 'coral', false],
            ['LA', 'purple', false],
          ].map(([initials, tone, speaking]) => (
            <div key={initials as string} className={`dm-tile ${speaking ? 'speaking' : ''}`}>
              <Avatar initials={initials as string} tone={tone as string} />
            </div>
          ))}
        </div>
        <div className="dm-captions">
          {captions.map(([who, text], i) => (
            <p key={who} className="dm-in" style={delay(0.5 + i * 1.3)}>
              <b>{who}:</b> {text}
            </p>
          ))}
        </div>
      </div>
      <div className="dm-meet-side">
        <h5>Agenda</h5>
        {['Monthly numbers', 'Friday delivery', 'Budget'].map((item, i) => (
          <div key={item} className="dm-agenda">
            <span className="dm-tick dm-pop" style={delay(1 + i * 1.3)}>
              <Icon name="check" size={10} />
            </span>
            {item}
          </div>
        ))}
        <span className="dm-chip green dm-pop" style={delay(4.4)}>
          <Icon name="gavel" size={11} /> Budget review moved
        </span>
        <span className="dm-chip dm-pop" style={delay(5)}>
          <Icon name="task" size={11} /> Send numbers · Amara · Fri
        </span>
      </div>
    </div>
  );
}

function AskScene() {
  return (
    <div className="dm-ask">
      <div className="dm-ask-box">
        <Icon name="spark" size={15} />
        <span className="dm-typed" style={delay(0.3)}>
          What did we decide about the new branch?
        </span>
      </div>
      <div className="dm-shimmer dm-flash" style={delay(2.2)}>
        <i />
        <i />
      </div>
      <div className="dm-answer dm-in" style={delay(3)}>
        <p>
          The team decided to open the new branch on the 1st <sup>1</sup>. Kofi is checking stock before Friday’s delivery <sup>2</sup>, and the budget review
          moved to next week <sup>3</sup>.
        </p>
        <div className="dm-sources">
          {[
            ['chat', '#launch-team · Sara Lind'],
            ['task', 'Task · Check stock list'],
            ['video', 'Weekly review · Decisions'],
          ].map(([icon, label], i) => (
            <span key={label} className="dm-source dm-in" style={delay(3.6 + i * 0.3)}>
              <b>{i + 1}</b>
              <Icon name={icon} size={11} /> {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function DashboardsScene() {
  const bars = [42, 58, 50, 74, 66, 88, 80];
  return (
    <div className="dm-dash">
      <div className="dm-kpis">
        {[
          ['Tasks done this week', '128', '+18%'],
          ['On-time delivery', '92%', '+4%'],
          ['Open decisions', '3', '−2'],
        ].map(([label, value, trend], i) => (
          <div key={label} className="dm-kpi dm-in" style={delay(0.2 + i * 0.2)}>
            <small>{label}</small>
            <b>{value}</b>
            <em>{trend}</em>
          </div>
        ))}
      </div>
      <div className="dm-charts">
        <div className="dm-chart">
          <small>Completed per week</small>
          <div className="dm-bars">
            {bars.map((h, i) => (
              <i key={i} className="dm-grow-y" style={{ height: `${h}%`, ...delay(0.6 + i * 0.12) }} />
            ))}
          </div>
        </div>
        <div className="dm-chart dm-donut-card">
          <small>By status</small>
          <svg viewBox="0 0 42 42" className="dm-donut">
            <circle className="dm-ring-bg" cx="21" cy="21" r="15.9" />
            <circle className="dm-ring a" cx="21" cy="21" r="15.9" style={{ '--len': 55 } as CSSProperties} />
            <circle className="dm-ring b" cx="21" cy="21" r="15.9" style={{ '--len': 30, '--off': -55 } as CSSProperties} />
          </svg>
          <span className="dm-legend">
            <i className="a" /> Done <i className="b" /> Doing
          </span>
        </div>
      </div>
    </div>
  );
}

const SCENE_VIEW: Record<SceneId, () => ReactNode> = {
  chat: ChatScene,
  projects: ProjectsScene,
  docs: DocsScene,
  meetings: MeetingsScene,
  ask: AskScene,
  dashboards: DashboardsScene,
};

const prefersReducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function ProductDemo() {
  // `run` changes every time a scene starts, so choosing the current tab replays it.
  const [{ index, run }, setScene] = useState({ index: 0, run: 0 });
  const [hovered, setHovered] = useState(false);
  const [visible, setVisible] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const remaining = useRef(DURATION);
  const startedRun = useRef(-1);
  const reduced = useRef(prefersReducedMotion());
  const running = !hovered && visible && !reduced.current;

  // Pause while scrolled out of view.
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Advance after the scene's remaining time; pausing keeps the time left, a new scene starts afresh.
  useEffect(() => {
    if (startedRun.current !== run) {
      startedRun.current = run;
      remaining.current = DURATION;
    }
    if (!running) return;
    const started = Date.now();
    const timer = window.setTimeout(() => setScene((s) => ({ index: (s.index + 1) % SCENES.length, run: s.run + 1 })), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [running, run]);

  const choose = (i: number) => setScene((s) => ({ index: i, run: s.run + 1 }));

  // A gentle 3D tilt that follows the pointer.
  const tilt = (e: React.PointerEvent) => {
    const el = frame.current;
    if (!el || reduced.current || e.pointerType !== 'mouse') return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--rx', `${((e.clientY - r.top) / r.height - 0.5) * -5}deg`);
    el.style.setProperty('--ry', `${((e.clientX - r.left) / r.width - 0.5) * 7}deg`);
  };
  const untilt = () => {
    frame.current?.style.setProperty('--rx', '0deg');
    frame.current?.style.setProperty('--ry', '0deg');
  };

  const scene = SCENES[index];
  const View = SCENE_VIEW[scene.id];
  return (
    <div className="demo" ref={root} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div className="demo-tabs" role="tablist" aria-label="Product tour">
        {SCENES.map((s, i) => (
          <button
            key={s.id}
            role="tab"
            id={`demo-tab-${s.id}`}
            aria-selected={i === index}
            aria-controls="demo-panel"
            className={`demo-tab ${i === index ? 'active' : ''}`}
            onClick={() => choose(i)}
          >
            <Icon name={s.icon} size={15} /> {s.label}
            {i === index && <i key={run} className={`demo-progress ${running ? '' : 'paused'}`} style={{ animationDuration: `${DURATION}ms` }} />}
          </button>
        ))}
      </div>
      <div className="demo-perspective" onPointerMove={tilt} onPointerLeave={untilt}>
        <div className="demo-frame" ref={frame}>
          <div className="demo-chrome" aria-hidden="true">
            <i />
            <i />
            <i />
            <span>Küü · {scene.label}</span>
          </div>
          <div className="demo-app">
            <div className="demo-nav" aria-hidden="true">
              <img src="/favicon.svg" alt="" />
              {SCENES.map((s, i) => (
                <span key={s.id} className={i === index ? 'active' : ''}>
                  <Icon name={s.icon} size={15} />
                </span>
              ))}
            </div>
            <div className="demo-main" id="demo-panel" role="tabpanel" aria-labelledby={`demo-tab-${scene.id}`}>
              <div className="demo-title">
                <b>{scene.title}</b>
                <span className="demo-online">
                  <i /> 5 online
                </span>
              </div>
              <div className="demo-stage" key={run} aria-hidden="true">
                <View />
              </div>
              <p className="sr-only">{scene.caption}</p>
            </div>
          </div>
        </div>
      </div>
      <p className="demo-caption" key={scene.id}>
        {scene.caption}
      </p>
    </div>
  );
}
