import { useState } from 'react';
import { View } from 'react-native';
import Svg, { Circle, G, Line, Polyline, Text as SvgText } from 'react-native-svg';
import { LABEL_COLORS } from '../lib/api';
import { SWATCH, useTheme, type Palette } from '../lib/theme';
import { Muted, Row, T } from './kit';

/** Dashboard charts drawn with react-native-svg, following the theme, with text alternatives. */

export interface SeriesItem {
  key: string;
  label: string;
  value: number;
  color?: string;
}

export function colorFor(c: Palette, item: { key: string; color?: string }, index: number) {
  const named: Record<string, string> = {
    todo: c.muted,
    in_progress: SWATCH.blue,
    blocked: c.red,
    review: SWATCH.lilac,
    done: c.green,
    urgent: c.red,
    high: SWATCH.orange,
    medium: SWATCH.gold,
    low: SWATCH.sky,
    on_track: c.green,
    at_risk: c.amber,
    off_track: c.red,
  };
  if (item.color && (LABEL_COLORS as string[]).includes(item.color)) return SWATCH[item.color];
  if (named[item.key]) return named[item.key];
  if (item.key === '' || item.key === 'none') return c.line;
  return SWATCH[LABEL_COLORS[index % LABEL_COLORS.length]];
}

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 1 }));

export function BarChart({ items, unit }: { items: SeriesItem[]; unit?: string }) {
  const { c } = useTheme();
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <View style={{ gap: 8 }} accessibilityLabel={items.map((i) => `${i.label}: ${i.value}`).join(', ')}>
      {items.map((item, i) => (
        <Row key={item.key || i} gap={8}>
          <T size={13} numberOfLines={1} style={{ width: 96 }}>
            {item.label}
          </T>
          <View style={{ flex: 1, height: 10, borderRadius: 5, backgroundColor: c.line2, overflow: 'hidden' }}>
            <View style={{ width: `${(item.value / max) * 100}%`, height: 10, borderRadius: 5, backgroundColor: colorFor(c, item, i) }} />
          </View>
          <T size={13} weight="bold" style={{ minWidth: 34, textAlign: 'right' }}>
            {fmt(item.value)}
            {unit ? <T size={11} tone="muted">{` ${unit}`}</T> : null}
          </T>
        </Row>
      ))}
    </View>
  );
}

export function DonutChart({ items, label = 'total' }: { items: SeriesItem[]; label?: string }) {
  const { c } = useTheme();
  const total = items.reduce((s, i) => s + i.value, 0);
  const r = 42;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  return (
    <Row gap={14} style={{ alignItems: 'center' }}>
      <Svg width={120} height={120} viewBox="0 0 120 120" accessibilityLabel={items.map((i) => `${i.label}: ${i.value}`).join(', ')}>
        <Circle cx={60} cy={60} r={r} fill="none" stroke={c.line} strokeWidth={16} />
        {total > 0 &&
          items.map((item, i) => {
            if (!item.value) return null;
            const len = (item.value / total) * circ;
            const seg = <Circle key={item.key || i} cx={60} cy={60} r={r} fill="none" stroke={colorFor(c, item, i)} strokeWidth={16} strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={-offset} transform="rotate(-90 60 60)" />;
            offset += len;
            return seg;
          })}
        <SvgText x={60} y={60} textAnchor="middle" fontSize={20} fontWeight="800" fill={c.ink}>
          {fmt(total)}
        </SvgText>
        <SvgText x={60} y={76} textAnchor="middle" fontSize={10} fill={c.muted}>
          {label}
        </SvgText>
      </Svg>
      <View style={{ flex: 1, gap: 6 }}>
        {items.map((item, i) => (
          <Row key={item.key || i} gap={6}>
            <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: colorFor(c, item, i) }} />
            <T size={13} style={{ flex: 1 }} numberOfLines={1}>
              {item.label}
            </T>
            <T size={13} weight="bold">
              {fmt(item.value)}
            </T>
            {total > 0 && <Muted size={11}>{Math.round((item.value / total) * 100)}%</Muted>}
          </Row>
        ))}
      </View>
    </Row>
  );
}

export function LineChart({ labels, series }: { labels: string[]; series: { key: string; label: string; values: number[] }[] }) {
  const { c } = useTheme();
  const [W, setW] = useState(300);
  const H = 170;
  const pad = { l: 28, r: 8, t: 10, b: 22 };
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const x = (i: number) => pad.l + (labels.length > 1 ? (i / (labels.length - 1)) * (W - pad.l - pad.r) : 0);
  const y = (v: number) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const colors = [c.accent, c.green, SWATCH.blue, SWATCH.gold];
  const ticks = [0, Math.round(max / 2), max];
  const step = Math.ceil(labels.length / Math.max(2, Math.floor(W / 70)));
  const short = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return (
    <View onLayout={(e) => setW(Math.max(200, Math.round(e.nativeEvent.layout.width)))} style={{ gap: 8 }}>
      <Svg width={W} height={H} accessibilityLabel={series.map((s) => `${s.label}: ${s.values.join(', ')}`).join('; ')}>
        {ticks.map((t) => (
          <G key={t}>
            <Line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={c.line} strokeWidth={1} />
            <SvgText x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill={c.muted}>
              {t}
            </SvgText>
          </G>
        ))}
        {labels.map((l, i) =>
          i === labels.length - 1 || (i % step === 0 && labels.length - 1 - i >= step) ? (
            <SvgText key={l} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'} fontSize={10} fill={c.muted}>
              {short(l)}
            </SvgText>
          ) : null,
        )}
        {series.map((s, si) => (
          <G key={s.key}>
            <Polyline fill="none" stroke={colors[si % colors.length]} strokeWidth={2.5} strokeLinejoin="round" points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
            {s.values.map((v, i) => (
              <Circle key={i} cx={x(i)} cy={y(v)} r={3.5} fill={colors[si % colors.length]} />
            ))}
          </G>
        ))}
      </Svg>
      <Row wrap gap={12}>
        {series.map((s, si) => (
          <Row key={s.key} gap={5}>
            <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: colors[si % colors.length] }} />
            <T size={12}>{s.label}</T>
            <T size={12} weight="bold">
              {s.values.reduce((a, b) => a + b, 0)}
            </T>
          </Row>
        ))}
      </Row>
    </View>
  );
}
