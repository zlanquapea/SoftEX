import { useEffect, useRef, useState } from 'react';
import { LABEL_COLORS } from '../api';

/**
 * Small dependency-free SVG charts for dashboards. They draw from CSS colour tokens, so they
 * follow light and dark mode, and they carry text alternatives for screen readers.
 */

export interface SeriesItem {
  key: string;
  label: string;
  value: number;
  color?: string;
}

const NAMED: Record<string, string> = {
  todo: 'var(--muted)',
  in_progress: 'var(--c-blue)',
  blocked: 'var(--red)',
  review: 'var(--c-lilac)',
  done: 'var(--green)',
  urgent: 'var(--red)',
  high: 'var(--c-orange)',
  medium: 'var(--c-gold)',
  low: 'var(--c-sky)',
  on_track: 'var(--green)',
  at_risk: 'var(--amber)',
  off_track: 'var(--red)',
};

/** A fill for a series item: its own colour name, a known key, or the palette in order. */
export function colorFor(item: { key: string; color?: string }, index: number) {
  if (item.color && (LABEL_COLORS as string[]).includes(item.color)) return `var(--c-${item.color})`;
  if (NAMED[item.key]) return NAMED[item.key];
  if (item.key === '' || item.key === 'none') return 'var(--line)';
  return `var(--c-${LABEL_COLORS[index % LABEL_COLORS.length]})`;
}

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 1 }));

/** Horizontal bars with labels: easy to read on a phone and with long names. */
export function BarChart({ items, unit, onSelect }: { items: SeriesItem[]; unit?: string; onSelect?: (item: SeriesItem) => void }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="bar-chart" aria-label="Bar chart">
      {items.map((item, i) => (
        <li key={item.key || i}>
          <span className="bar-chart-label" title={item.label}>
            {item.label}
          </span>
          <span className="bar-chart-track" aria-hidden="true">
            <i style={{ width: `${(item.value / max) * 100}%`, background: colorFor(item, i) }} />
          </span>
          <strong className="bar-chart-value">
            {onSelect ? (
              <button className="link-btn" onClick={() => onSelect(item)}>
                {fmt(item.value)}
              </button>
            ) : (
              fmt(item.value)
            )}
            {unit && <small className="muted"> {unit}</small>}
          </strong>
        </li>
      ))}
    </ul>
  );
}

/** A donut with a legend; the centre shows the total. */
export function DonutChart({ items, label = 'total' }: { items: SeriesItem[]; label?: string }) {
  const total = items.reduce((s, i) => s + i.value, 0);
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="donut">
      <svg viewBox="0 0 120 120" role="img" aria-label={items.map((i) => `${i.label}: ${i.value}`).join(', ')}>
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--line)" strokeWidth="16" />
        {total > 0 &&
          items.map((item, i) => {
            if (!item.value) return null;
            const len = (item.value / total) * c;
            const seg = (
              <circle
                key={item.key || i}
                cx="60"
                cy="60"
                r={r}
                fill="none"
                stroke={colorFor(item, i)}
                strokeWidth="16"
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 60 60)"
              />
            );
            offset += len;
            return seg;
          })}
        <text x="60" y="58" textAnchor="middle" className="donut-total">
          {fmt(total)}
        </text>
        <text x="60" y="74" textAnchor="middle" className="donut-caption">
          {label}
        </text>
      </svg>
      <ul className="chart-legend">
        {items.map((item, i) => (
          <li key={item.key || i}>
            <i style={{ background: colorFor(item, i) }} /> {item.label} <strong>{fmt(item.value)}</strong>
            {total > 0 && <small className="muted"> {Math.round((item.value / total) * 100)}%</small>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Lines over weeks, with a dot per point and the values in a hidden table. */
export function LineChart({ labels, series }: { labels: string[]; series: { key: string; label: string; values: number[] }[] }) {
  // Drawn at the container's real width so text and dots keep their shape on any screen.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(600);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setW(Math.max(200, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 180;
  const pad = { l: 30, r: 10, t: 10, b: 24 };
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const x = (i: number) => pad.l + (labels.length > 1 ? (i / (labels.length - 1)) * (W - pad.l - pad.r) : 0);
  const y = (v: number) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const colors = ['var(--accent)', 'var(--green)', 'var(--c-blue)', 'var(--c-gold)'];
  const ticks = [0, Math.round(max / 2), max];
  // Room for about one date every 70px; the last week is always labelled.
  const step = Math.ceil(labels.length / Math.max(2, Math.floor(W / 70)));
  const short = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return (
    <div className="line-chart" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={series.map((s) => `${s.label}: ${s.values.join(', ')}`).join('; ')}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="axis">
              {t}
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          (i === labels.length - 1 || (i % step === 0 && labels.length - 1 - i >= step)) ? (
            <text key={l} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'} className="axis">
              {short(l)}
            </text>
          ) : null,
        )}
        {series.map((s, si) => (
          <g key={s.key}>
            <polyline fill="none" stroke={colors[si % colors.length]} strokeWidth="2.5" strokeLinejoin="round" points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
            {s.values.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r="3.5" fill={colors[si % colors.length]}>
                <title>
                  {s.label}, week of {short(labels[i])}: {v}
                </title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
      <ul className="chart-legend inline">
        {series.map((s, si) => (
          <li key={s.key}>
            <i style={{ background: colors[si % colors.length] }} /> {s.label} <strong>{s.values.reduce((a, b) => a + b, 0)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}
