import { useEffect, useState } from 'react';
import { api, type TimeEntry } from '../api';
import { Icon } from '../components/Icon';
import { useShell } from '../components/Layout';
import { UpgradeNotice, usePlan } from '../components/Plan';
import { useElapsed } from '../components/Work';
import { Empty, ErrorState, Loading, useAction } from '../components/ui';
import { duration } from '../format';
import { useApi } from '../hooks';

interface Week {
  week: string;
  entries: (TimeEntry & { project_id: string | null })[];
  days: { date: string; minutes: number }[];
  total_minutes: number;
  running: TimeEntry | null;
}

const shift = (week: string, days: number) => {
  const d = new Date(`${week}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** My timesheet: the week's logged time, day by day (Harvest/ClickUp style). */
export function Timesheet() {
  const plan = usePlan();
  const act = useAction();
  const { openTask } = useShell();
  const [week, setWeek] = useState<string | undefined>(undefined);
  const { data, error, reload } = useApi<Week>(`/time/me${week ? `?week=${week}` : ''}`);
  const elapsed = useElapsed(data?.running?.started_at);
  useEffect(() => {
    window.addEventListener('kuu:time', reload);
    return () => window.removeEventListener('kuu:time', reload);
  }, [reload]);
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading />;
  // Without the feature, time logged earlier stays readable; logging more needs the plan.
  if (!plan.has('fields') && !data.days.some((d) => d.minutes > 0)) {
    return (
      <div className="page">
        <h1>Timesheet</h1>
        <UpgradeNotice feature="fields" />
      </div>
    );
  }
  const max = Math.max(...data.days.map((d) => d.minutes), 60);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Timesheet</h1>
          <p className="muted">Time you’ve logged on tasks. Start a timer or log time from any task.</p>
        </div>
        <div className="row-gap">
          <button className="icon-btn" aria-label="Previous week" onClick={() => setWeek(shift(data.week, -7))}>
            <Icon name="chevronLeft" />
          </button>
          <strong>Week of {new Date(`${data.week}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}</strong>
          <button className="icon-btn" aria-label="Next week" onClick={() => setWeek(shift(data.week, 7))}>
            <Icon name="chevronRight" />
          </button>
          {week && (
            <button className="btn sm" onClick={() => setWeek(undefined)}>
              This week
            </button>
          )}
        </div>
      </div>
      {!plan.has('fields') && <UpgradeNotice feature="fields" compact readOnly />}

      {data.running && (
        <div className="card pad row-gap timer-banner">
          <span className="rec-dot" />
          <strong>{elapsed}</strong>
          <button className="link-btn grow text-left" onClick={() => openTask(data.running!.task_id)}>
            {data.running.task_title}
          </button>
          <button
            className="btn sm"
            onClick={async () => {
              await act(() => api.post('/time/stop'));
              reload();
            }}
          >
            Stop
          </button>
        </div>
      )}

      <section className="card pad">
        <div className="week-bars">
          {data.days.map((d) => (
            <div key={d.date} className={`week-day ${d.date === today ? 'today' : ''}`}>
              <span className="week-bar">
                <i style={{ height: `${(d.minutes / max) * 100}%` }} />
              </span>
              <strong>{d.minutes ? duration(d.minutes) : '—'}</strong>
              <small className="muted">{new Date(`${d.date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })}</small>
            </div>
          ))}
        </div>
        <p className="muted">
          Total this week: <strong>{duration(data.total_minutes)}</strong>
        </p>
      </section>

      <section className="card">
        {!data.entries.length ? (
          <Empty icon="clock" title="No time logged this week" />
        ) : (
          data.entries
            .slice()
            .reverse()
            .map((e) => (
              <div key={e.id} className="mini-task pad">
                <small className="muted">{new Date(e.started_at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</small>
                <strong>{e.running ? elapsed : duration(e.minutes)}</strong>
                <button className="link-btn grow text-left" onClick={() => openTask(e.task_id)}>
                  {e.task_title}
                </button>
                {e.note && <span className="muted">{e.note}</span>}
                {!e.running && (
                  <button
                    className="icon-btn xs"
                    aria-label="Remove time entry"
                    onClick={async () => {
                      await act(() => api.del(`/time/${e.id}`));
                      reload();
                    }}
                  >
                    <Icon name="x" size={12} />
                  </button>
                )}
              </div>
            ))
        )}
      </section>
    </div>
  );
}
