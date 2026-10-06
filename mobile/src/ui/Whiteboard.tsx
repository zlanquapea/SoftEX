import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Platform, Pressable, ScrollView, View, type GestureResponderEvent, type LayoutRectangle } from 'react-native';
import Svg, { Circle, Defs, Ellipse, G, Line, Marker, Path, Pattern, Rect, Text as SvgText, TSpan } from 'react-native-svg';
import * as Y from 'yjs';
import { LOCAL, type LiveDoc } from '../lib/collab';
import { swatch, useTheme } from '../lib/theme';
import { Icon } from './Icon';
import { Button, Input, Muted, Sheet, T, useToast } from './kit';

/**
 * The collaborative whiteboard on a phone: same Y.Map of elements as the web, drawn with
 * react-native-svg. One finger uses the current tool; two fingers pan and pinch to zoom.
 */

export type Tool = 'select' | 'hand' | 'sticky' | 'rect' | 'ellipse' | 'text' | 'arrow' | 'pen';
export interface El {
  id: string;
  type: 'sticky' | 'rect' | 'ellipse' | 'text' | 'arrow' | 'pen';
  x: number;
  y: number;
  w: number;
  h: number;
  x2?: number;
  y2?: number;
  from?: string | null;
  to?: string | null;
  points?: number[];
  color: string;
  text?: string;
  z: number;
}

const STICKY = ['#FFE58A', '#FFC4B8', '#C6F0C2', '#BFE3FF', '#FFD19A', '#E3CCFF'];
const INK = ['#2B2118', '#B5461B', '#2F7D4F', '#2F6FB5', '#8A4FC4', '#C98A00'];
const TOOLS: { id: Tool; icon: string; label: string }[] = [
  { id: 'select', icon: 'cursor', label: 'Select and move' },
  { id: 'hand', icon: 'hand', label: 'Pan' },
  { id: 'sticky', icon: 'sticky', label: 'Sticky note' },
  { id: 'rect', icon: 'square', label: 'Rectangle' },
  { id: 'ellipse', icon: 'circle', label: 'Ellipse' },
  { id: 'text', icon: 'type', label: 'Text' },
  { id: 'arrow', icon: 'arrow', label: 'Arrow (drag between shapes to connect them)' },
  { id: 'pen', icon: 'pen', label: 'Pen' },
];

const newId = () => Math.random().toString(36).slice(2, 11);
const safeColor = (c: unknown, fallback = '#2B2118') => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : fallback);
const boxable = (e: El) => e.type !== 'arrow' && e.type !== 'pen';

function edgePoint(e: El, tx: number, ty: number) {
  const cx = e.x + e.w / 2;
  const cy = e.y + e.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  if (e.type === 'ellipse') {
    const t = 1 / Math.sqrt((dx * dx) / (e.w / 2) ** 2 + (dy * dy) / (e.h / 2) ** 2);
    return { x: cx + dx * t, y: cy + dy * t };
  }
  const t = Math.min(Math.abs(e.w / 2 / (dx || 1e-9)), Math.abs(e.h / 2 / (dy || 1e-9)));
  return { x: cx + dx * t, y: cy + dy * t };
}

export function arrowEnds(a: El, byId: Map<string, El>) {
  const from = a.from ? byId.get(a.from) : undefined;
  const to = a.to ? byId.get(a.to) : undefined;
  let x1 = a.x;
  let y1 = a.y;
  let x2 = a.x2 ?? a.x;
  let y2 = a.y2 ?? a.y;
  if (from) ({ x: x1, y: y1 } = { x: from.x + from.w / 2, y: from.y + from.h / 2 });
  if (to) ({ x: x2, y: y2 } = { x: to.x + to.w / 2, y: to.y + to.h / 2 });
  if (from) ({ x: x1, y: y1 } = edgePoint(from, x2, y2));
  if (to) ({ x: x2, y: y2 } = edgePoint(to, x1, y1));
  return { x1, y1, x2, y2 };
}

function bounds(els: El[], byId: Map<string, El>) {
  if (!els.length) return { x: 0, y: 0, w: 800, h: 600 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of els) {
    if (e.type === 'arrow') {
      const { x1, y1, x2, y2 } = arrowEnds(e, byId);
      minX = Math.min(minX, x1, x2);
      minY = Math.min(minY, y1, y2);
      maxX = Math.max(maxX, x1, x2);
      maxY = Math.max(maxY, y1, y2);
    } else {
      minX = Math.min(minX, e.x);
      minY = Math.min(minY, e.y);
      maxX = Math.max(maxX, e.x + e.w);
      maxY = Math.max(maxY, e.y + e.h);
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function wrap(text: string, width: number, size: number) {
  const perLine = Math.max(4, Math.floor(width / (size * 0.55)));
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      if ((line + ' ' + word).trim().length > perLine && line) {
        out.push(line);
        line = word;
      } else line = (line + ' ' + word).trim();
    }
    out.push(line);
  }
  return out;
}

const penPath = (e: El) => {
  const pts = e.points ?? [];
  return pts.reduce((acc, v, i) => (i % 2 ? acc : `${acc}${i ? 'L' : 'M'}${e.x + v} ${e.y + pts[i + 1]} `), '');
};

function Shape({ e: raw, byId, selected, accent, fill, ink }: { e: El; byId: Map<string, El>; selected: boolean; accent: string; fill: string; ink: string }) {
  const e = { ...raw, color: safeColor(raw.color, raw.type === 'sticky' ? STICKY[0] : INK[0]) };
  const stroke = selected ? accent : undefined;
  if (e.type === 'arrow') {
    const { x1, y1, x2, y2 } = arrowEnds(e, byId);
    return <Line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke ?? e.color} strokeWidth={2.5} markerEnd="url(#wb-arrow)" />;
  }
  if (e.type === 'pen') return <Path d={penPath(e)} fill="none" stroke={stroke ?? e.color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />;
  const size = e.type === 'text' ? 18 : 15;
  const lines = wrap(e.text ?? '', e.w - 16, size);
  const lh = size * 1.3;
  const top = e.type === 'text' ? e.y + size : e.y + e.h / 2 - ((lines.length - 1) * lh) / 2 + size * 0.35;
  const tx = e.type === 'text' ? e.x + 2 : e.x + e.w / 2;
  return (
    <G>
      {e.type === 'sticky' && <Rect x={e.x} y={e.y} width={e.w} height={e.h} rx={4} fill={e.color} stroke={stroke ?? '#00000018'} strokeWidth={selected ? 2 : 1} />}
      {e.type === 'rect' && <Rect x={e.x} y={e.y} width={e.w} height={e.h} rx={8} fill={fill} stroke={stroke ?? e.color} strokeWidth={2} />}
      {e.type === 'ellipse' && <Ellipse cx={e.x + e.w / 2} cy={e.y + e.h / 2} rx={e.w / 2} ry={e.h / 2} fill={fill} stroke={stroke ?? e.color} strokeWidth={2} />}
      {e.type === 'text' && selected && <Rect x={e.x} y={e.y} width={e.w} height={e.h} fill="transparent" stroke={accent} strokeDasharray="4 3" />}
      <SvgText x={tx} y={top} textAnchor={e.type === 'text' ? 'start' : 'middle'} fontSize={size} fill={e.type === 'sticky' ? '#2B2118' : e.type === 'text' ? e.color : ink}>
        {lines.map((l, i) => (
          <TSpan key={i} x={tx} dy={i ? lh : 0}>
            {l || ' '}
          </TSpan>
        ))}
      </SvgText>
    </G>
  );
}

type Drag =
  | { kind: 'move'; start: { x: number; y: number }; origin: Map<string, El> }
  | { kind: 'resize'; id: string; start: { x: number; y: number }; origin: El }
  | { kind: 'pan'; start: { x: number; y: number }; view: { x: number; y: number } }
  | { kind: 'pinch'; dist: number; mid: { x: number; y: number }; view: { x: number; y: number; zoom: number } }
  | { kind: 'create'; id: string; start: { x: number; y: number } }
  | { kind: 'arrow'; id: string }
  | { kind: 'pen'; id: string; pts: number[]; origin: { x: number; y: number } }
  | { kind: 'tap'; start: { x: number; y: number }; target?: string };

export function Whiteboard({ live, title }: { live: LiveDoc; title: string }) {
  const { c } = useTheme();
  const toast = useToast();
  const doc = live.doc;
  const map = useMemo(() => doc.getMap<El>('elements'), [doc]);
  const undo = useMemo(() => new Y.UndoManager(map, { trackedOrigins: new Set([LOCAL]), captureTimeout: 400 }), [map]);
  const [els, setEls] = useState<El[]>(() => [...map.values()]);
  const [tool, setTool] = useState<Tool>('select');
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [view, setView] = useState({ x: 20, y: 20, zoom: 0.8 });
  const [color, setColor] = useState({ sticky: STICKY[0], ink: INK[0] });
  const layout = useRef<LayoutRectangle>({ x: 0, y: 0, width: 360, height: 600 });
  const drag = useRef<Drag | null>(null);
  const readOnly = !live.canEdit;

  useEffect(() => {
    const update = () => setEls([...map.values()]);
    update();
    map.observe(update);
    return () => map.unobserve(update);
  }, [map]);
  useEffect(() => () => undo.destroy(), [undo]);

  const byId = useMemo(() => new Map(els.map((e) => [e.id, e])), [els]);
  const sorted = useMemo(() => [...els].sort((a, b) => (a.type === 'arrow' ? -1 : 0) - (b.type === 'arrow' ? -1 : 0) || a.z - b.z), [els]);
  const topZ = () => Math.max(0, ...els.map((e) => e.z)) + 1;
  const set = (list: El[]) => doc.transact(() => list.forEach((e) => map.set(e.id, e)), LOCAL);
  const remove = (ids: string[]) =>
    doc.transact(() => {
      for (const id of ids) map.delete(id);
      for (const e of map.values()) if (e.type === 'arrow' && (ids.includes(e.from ?? '') || ids.includes(e.to ?? ''))) map.delete(e.id);
    }, LOCAL);

  // The latest values for the gesture handlers, which are created once.
  const state = useRef({ view, tool, selected, byId, sorted, color, readOnly, els });
  state.current = { view, tool, selected, byId, sorted, color, readOnly, els };

  const toWorld = (lx: number, ly: number) => {
    const v = state.current.view;
    return { x: (lx - v.x) / v.zoom, y: (ly - v.y) / v.zoom };
  };
  const hitTest = (p: { x: number; y: number }) => {
    const { sorted: list, byId: ids } = state.current;
    for (const e of [...list].reverse()) {
      if (boxable(e) && p.x >= e.x && p.x <= e.x + e.w && p.y >= e.y && p.y <= e.y + e.h) return e;
      if (e.type === 'arrow') {
        const { x1, y1, x2, y2 } = arrowEnds(e, ids);
        const len = Math.hypot(x2 - x1, y2 - y1) || 1;
        const t = Math.max(0, Math.min(1, ((p.x - x1) * (x2 - x1) + (p.y - y1) * (y2 - y1)) / len ** 2));
        if (Math.hypot(p.x - (x1 + t * (x2 - x1)), p.y - (y1 + t * (y2 - y1))) < 12) return e;
      }
      if (e.type === 'pen' && p.x >= e.x - 8 && p.x <= e.x + e.w + 8 && p.y >= e.y - 8 && p.y <= e.y + e.h + 8) return e;
    }
    return undefined;
  };
  const shapeAt = (p: { x: number; y: number }, except?: string) =>
    [...state.current.sorted].reverse().find((e) => boxable(e) && e.id !== except && p.x >= e.x && p.x <= e.x + e.w && p.y >= e.y && p.y <= e.y + e.h);

  const local = (ev: GestureResponderEvent) => ({ x: ev.nativeEvent.locationX, y: ev.nativeEvent.locationY });
  const touches = (ev: GestureResponderEvent) => ev.nativeEvent.touches;

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (ev) => {
          const s = state.current;
          const pt = local(ev);
          const p = toWorld(pt.x, pt.y);
          if (touches(ev).length >= 2) return;
          if (s.tool === 'hand') {
            drag.current = { kind: 'pan', start: pt, view: { x: s.view.x, y: s.view.y } };
            return;
          }
          const single = s.selected.length === 1 ? s.byId.get(s.selected[0]) : undefined;
          if (single && boxable(single) && !s.readOnly) {
            const hx = single.x + single.w;
            const hy = single.y + single.h;
            if (Math.abs(p.x - hx) < 18 / s.view.zoom && Math.abs(p.y - hy) < 18 / s.view.zoom) {
              drag.current = { kind: 'resize', id: single.id, start: p, origin: single };
              return;
            }
          }
          if (s.tool === 'select' || s.readOnly) {
            const target = hitTest(p);
            if (target) {
              const next = s.selected.includes(target.id) ? s.selected : [target.id];
              setSelected(next);
              drag.current = s.readOnly ? { kind: 'tap', start: p, target: target.id } : { kind: 'move', start: p, origin: new Map(next.map((id) => [id, s.byId.get(id)!])) };
            } else {
              setSelected([]);
              drag.current = { kind: 'pan', start: pt, view: { x: s.view.x, y: s.view.y } };
            }
            return;
          }
          const id = newId();
          const z = Math.max(0, ...s.els.map((e) => e.z)) + 1;
          setSelected([]);
          if (s.tool === 'arrow') {
            const from = shapeAt(p);
            set([{ id, type: 'arrow', x: p.x, y: p.y, x2: p.x, y2: p.y, w: 0, h: 0, from: from?.id ?? null, to: null, color: s.color.ink, z }]);
            drag.current = { kind: 'arrow', id };
          } else if (s.tool === 'pen') {
            set([{ id, type: 'pen', x: p.x, y: p.y, w: 1, h: 1, points: [0, 0], color: s.color.ink, z }]);
            drag.current = { kind: 'pen', id, pts: [0, 0], origin: p };
          } else if (s.tool === 'sticky' || s.tool === 'text') {
            const size = s.tool === 'sticky' ? { w: 180, h: 140 } : { w: 220, h: 34 };
            set([{ id, type: s.tool, x: p.x - size.w / 2, y: p.y - size.h / 2, ...size, color: s.tool === 'sticky' ? s.color.sticky : s.color.ink, text: '', z }]);
            setSelected([id]);
            setEditing({ id, text: '' });
            setTool('select');
          } else {
            set([{ id, type: s.tool, x: p.x, y: p.y, w: 1, h: 1, color: s.color.ink, text: '', z }]);
            drag.current = { kind: 'create', id, start: p };
          }
        },
        onPanResponderMove: (ev) => {
          const s = state.current;
          const t = touches(ev);
          if (t.length >= 2) {
            const [a, b] = [t[0], t[1]];
            const dist = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
            const mid = { x: (a.pageX + b.pageX) / 2 - layout.current.x, y: (a.pageY + b.pageY) / 2 - layout.current.y };
            const d = drag.current;
            if (d?.kind !== 'pinch') {
              drag.current = { kind: 'pinch', dist, mid, view: { ...s.view } };
              return;
            }
            const zoom = Math.min(4, Math.max(0.2, (d.view.zoom * dist) / d.dist));
            setView({ zoom, x: mid.x - ((d.mid.x - d.view.x) * zoom) / d.view.zoom, y: mid.y - ((d.mid.y - d.view.y) * zoom) / d.view.zoom });
            return;
          }
          const pt = local(ev);
          const p = toWorld(pt.x, pt.y);
          const d = drag.current;
          if (!d) return;
          if (d.kind === 'pan') setView((v) => ({ ...v, x: d.view.x + pt.x - d.start.x, y: d.view.y + pt.y - d.start.y }));
          else if (d.kind === 'move') {
            const dx = p.x - d.start.x;
            const dy = p.y - d.start.y;
            set([...d.origin.values()].map((o) => ({ ...o, x: o.x + dx, y: o.y + dy, ...(o.type === 'arrow' ? { x2: (o.x2 ?? o.x) + dx, y2: (o.y2 ?? o.y) + dy } : {}) })));
          } else if (d.kind === 'resize') set([{ ...d.origin, w: Math.max(30, d.origin.w + p.x - d.start.x), h: Math.max(24, d.origin.h + p.y - d.start.y) }]);
          else if (d.kind === 'create') {
            const e = s.byId.get(d.id);
            if (e) set([{ ...e, x: Math.min(p.x, d.start.x), y: Math.min(p.y, d.start.y), w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) }]);
          } else if (d.kind === 'arrow') {
            const e = s.byId.get(d.id);
            if (e) set([{ ...e, x2: p.x, y2: p.y }]);
          } else if (d.kind === 'pen') {
            d.pts.push(p.x - d.origin.x, p.y - d.origin.y);
            const e = s.byId.get(d.id);
            if (e && d.pts.length % 4 === 0) set([{ ...e, points: [...d.pts] }]);
          }
          live.setPresence({ cursor: p });
        },
        onPanResponderRelease: (ev) => {
          const s = state.current;
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          const pt = local(ev);
          const p = toWorld(pt.x, pt.y);
          if (d.kind === 'create') {
            const e = s.byId.get(d.id);
            if (e && e.w < 8 && e.h < 8) set([{ ...e, x: e.x - 80, y: e.y - 50, w: 160, h: 100 }]);
            setSelected([d.id]);
            setTool('select');
          } else if (d.kind === 'arrow') {
            const e = s.byId.get(d.id);
            const to = shapeAt(p, e?.from ?? undefined);
            if (e) {
              if (!to && Math.hypot((e.x2 ?? 0) - e.x, (e.y2 ?? 0) - e.y) < 6 && !e.from) remove([e.id]);
              else set([{ ...e, to: to?.id ?? null, x2: p.x, y2: p.y }]);
            }
          } else if (d.kind === 'pen') {
            const e = s.byId.get(d.id);
            if (e) {
              const xs = d.pts.filter((_, i) => i % 2 === 0);
              const ys = d.pts.filter((_, i) => i % 2 === 1);
              const minX = Math.min(...xs);
              const minY = Math.min(...ys);
              set([{ ...e, x: e.x + minX, y: e.y + minY, w: Math.max(...xs) - minX || 1, h: Math.max(...ys) - minY || 1, points: d.pts.map((v, i) => v - (i % 2 ? minY : minX)) }]);
            }
          }
        },
      }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const zoomBy = (f: number) =>
    setView((v) => {
      const zoom = Math.min(4, Math.max(0.2, v.zoom * f));
      const cx = layout.current.width / 2;
      const cy = layout.current.height / 2;
      return { zoom, x: cx - ((cx - v.x) * zoom) / v.zoom, y: cy - ((cy - v.y) * zoom) / v.zoom };
    });
  const fit = () => {
    const b = bounds(els, byId);
    const { width, height } = layout.current;
    const zoom = Math.min(2, Math.max(0.2, Math.min((width - 40) / (b.w || 1), (height - 40) / (b.h || 1))));
    setView({ zoom, x: (width - b.w * zoom) / 2 - b.x * zoom, y: (height - b.h * zoom) / 2 - b.y * zoom });
  };

  const exportSvg = async () => {
    const b = bounds(els, byId);
    const esc = (s: string) => s.replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch]!);
    const parts = sorted.map((raw) => {
      const e = { ...raw, color: safeColor(raw.color, raw.type === 'sticky' ? STICKY[0] : INK[0]) };
      if (e.type === 'arrow') {
        const { x1, y1, x2, y2 } = arrowEnds(e, byId);
        return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${e.color}" stroke-width="2.5" marker-end="url(#a)"/>`;
      }
      if (e.type === 'pen') return `<path d="${penPath(e)}" fill="none" stroke="${e.color}" stroke-width="3" stroke-linecap="round"/>`;
      const size = e.type === 'text' ? 18 : 15;
      const lines = wrap(e.text ?? '', e.w - 16, size);
      const top = e.type === 'text' ? e.y + size : e.y + e.h / 2 - ((lines.length - 1) * size * 1.3) / 2 + size * 0.35;
      const tx = e.type === 'text' ? e.x + 2 : e.x + e.w / 2;
      const shape =
        e.type === 'sticky'
          ? `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" rx="4" fill="${e.color}"/>`
          : e.type === 'rect'
            ? `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" rx="8" fill="#fff" stroke="${e.color}" stroke-width="2"/>`
            : e.type === 'ellipse'
              ? `<ellipse cx="${e.x + e.w / 2}" cy="${e.y + e.h / 2}" rx="${e.w / 2}" ry="${e.h / 2}" fill="#fff" stroke="${e.color}" stroke-width="2"/>`
              : '';
      const text = `<text x="${tx}" y="${top}" text-anchor="${e.type === 'text' ? 'start' : 'middle'}" font-size="${size}" fill="${e.type === 'text' ? e.color : '#2B2118'}" font-family="system-ui,sans-serif">${lines.map((l, i) => `<tspan x="${tx}" dy="${i ? size * 1.3 : 0}">${esc(l) || ' '}</tspan>`).join('')}</text>`;
      return shape + text;
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x - 40} ${b.y - 40} ${b.w + 80} ${b.h + 80}" width="${Math.round(b.w + 80)}" height="${Math.round(b.h + 80)}"><defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#2B2118"/></marker></defs>${parts.join('')}</svg>`;
    const name = `${title.replace(/[^\w\- ]+/g, '').trim() || 'whiteboard'}.svg`;
    if (Platform.OS === 'web') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      a.download = name;
      a.click();
      return;
    }
    const file = new File(Paths.cache, name);
    file.write(svg);
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: 'image/svg+xml', dialogTitle: name });
    else toast('Sharing is not available on this device', 'error');
  };

  const sel = selected.map((id) => byId.get(id)).filter(Boolean) as El[];
  const single = sel.length === 1 ? sel[0] : null;
  const peers = [...live.peers.values()].filter((p) => p.cursor);
  const swatches = single?.type === 'sticky' || (!single && tool === 'sticky') ? STICKY : INK;

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <View
        style={{ flex: 1, overflow: 'hidden' }}
        onLayout={(e) => {
          layout.current = e.nativeEvent.layout;
        }}
        {...responder.panHandlers}
        accessibilityLabel={`Whiteboard with ${els.length} item${els.length === 1 ? '' : 's'}`}
      >
        <Svg width="100%" height="100%">
          <Defs>
            <Pattern id="wb-grid" width={24 * view.zoom} height={24 * view.zoom} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
              <Circle cx={1} cy={1} r={1} fill={c.line} />
            </Pattern>
            <Marker id="wb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <Path d="M0 0 L10 5 L0 10 z" fill={c.ink2} />
            </Marker>
          </Defs>
          <Rect x={0} y={0} width="100%" height="100%" fill="url(#wb-grid)" />
          <G transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
            {sorted.map((e) => (
              <Shape key={e.id} e={e} byId={byId} selected={selected.includes(e.id)} accent={c.accent} fill={c.wbFill} ink={c.ink} />
            ))}
            {single && boxable(single) && !readOnly && <Rect x={single.x + single.w - 8 / view.zoom} y={single.y + single.h - 8 / view.zoom} width={16 / view.zoom} height={16 / view.zoom} rx={3 / view.zoom} fill={c.accent} />}
            {peers.map((p) => (
              <G key={p.clientId} transform={`translate(${p.cursor!.x} ${p.cursor!.y}) scale(${1 / view.zoom})`}>
                <Path d="M0 0 L0 16 L4.5 12 L8 19 L10.5 18 L7 11 L13 11 z" fill={swatch(p.user.color)} stroke="#fff" strokeWidth={1} />
                <SvgText x={14} y={24} fontSize={12} fill={swatch(p.user.color)}>
                  {p.user.name}
                </SvgText>
              </G>
            ))}
          </G>
        </Svg>
        {!els.length && !readOnly && (
          <View pointerEvents="none" style={{ position: 'absolute', left: 24, right: 24, top: '40%', alignItems: 'center' }}>
            <Muted style={{ textAlign: 'center' }}>Pick a tool below and tap the board. Drag with two fingers to move around; pinch to zoom.</Muted>
          </View>
        )}
      </View>

      <View style={{ position: 'absolute', right: 10, top: 10, flexDirection: 'row', alignItems: 'center', gap: 2, backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, paddingHorizontal: 4 }}>
        <ToolButton icon="minus" label="Zoom out" onPress={() => zoomBy(1 / 1.25)} text="−" />
        <Pressable onPress={() => setView((v) => ({ ...v, zoom: 1 }))} accessibilityLabel="Reset zoom" hitSlop={6}>
          <T size={12} weight="bold" tone="ink2">
            {Math.round(view.zoom * 100)}%
          </T>
        </Pressable>
        <ToolButton icon="plus" label="Zoom in" onPress={() => zoomBy(1.25)} />
        <ToolButton icon="maximize" label="Fit to screen" onPress={fit} />
        <ToolButton icon="download" label="Share as SVG" onPress={exportSvg} />
      </View>

      {!readOnly && sel.length > 0 && (
        <View style={{ position: 'absolute', left: 10, right: 10, bottom: 74, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.surface, borderRadius: 14, borderWidth: 1, borderColor: c.line, padding: 6 }}>
          {swatches.map((col) => (
            <Pressable
              key={col}
              accessibilityLabel={`Colour ${col}`}
              onPress={() => {
                set(sel.map((e) => ({ ...e, color: e.type === 'sticky' ? (STICKY.includes(col) ? col : e.color) : INK.includes(col) ? col : e.color })));
                setColor((cur) => (STICKY.includes(col) ? { ...cur, sticky: col } : { ...cur, ink: col }));
              }}
              style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: col, borderWidth: 1, borderColor: c.lineStrong }}
            />
          ))}
          <View style={{ flex: 1 }} />
          {single && boxable(single) && <ToolButton icon="edit" label="Edit text" onPress={() => setEditing({ id: single.id, text: single.text ?? '' })} />}
          <ToolButton
            icon="layers"
            label="Duplicate"
            onPress={() => {
              const copies = sel.map((e) => ({ ...e, id: newId(), x: e.x + 24, y: e.y + 24, x2: e.x2 !== undefined ? e.x2 + 24 : undefined, z: topZ() }));
              set(copies);
              setSelected(copies.map((x) => x.id));
            }}
          />
          <ToolButton icon="arrow" label="Bring to front" onPress={() => set(sel.map((e, i) => ({ ...e, z: topZ() + i })))} />
          <ToolButton
            icon="trash"
            label="Delete selection"
            color={c.red}
            onPress={() => {
              remove(selected);
              setSelected([]);
            }}
          />
        </View>
      )}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ position: 'absolute', left: 10, right: 10, bottom: 12, flexGrow: 0 }}
        contentContainerStyle={{ gap: 2, padding: 6, backgroundColor: c.surface, borderRadius: 16, borderWidth: 1, borderColor: c.line }}
      >
        {TOOLS.filter((t) => !readOnly || t.id === 'select' || t.id === 'hand').map((t) => (
          <ToolButton key={t.id} icon={t.icon} label={t.label} active={tool === t.id} onPress={() => setTool(t.id)} />
        ))}
        {!readOnly && (
          <>
            <View style={{ width: 1, backgroundColor: c.line, marginHorizontal: 4 }} />
            {(tool === 'sticky' ? STICKY : INK).slice(0, 4).map((col) => (
              <Pressable
                key={col}
                accessibilityLabel={`Colour ${col}`}
                onPress={() => setColor((cur) => (STICKY.includes(col) ? { ...cur, sticky: col } : { ...cur, ink: col }))}
                style={{ width: 22, height: 22, margin: 7, borderRadius: 11, backgroundColor: col, borderWidth: 2, borderColor: col === color.sticky || col === color.ink ? c.ink : 'transparent' }}
              />
            ))}
            <ToolButton icon="undo" label="Undo" onPress={() => undo.undo()} />
            <ToolButton icon="redo" label="Redo" onPress={() => undo.redo()} />
          </>
        )}
      </ScrollView>

      <Sheet
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Edit text"
        footer={
          <Button
            title="Done"
            variant="primary"
            full
            onPress={() => {
              const e = editing && byId.get(editing.id);
              if (e) {
                if (!editing!.text.trim() && e.type === 'text') remove([e.id]);
                else {
                  const lines = wrap(editing!.text, e.w - 16, e.type === 'text' ? 18 : 15).length;
                  set([{ ...e, text: editing!.text, h: e.type === 'text' ? Math.max(34, lines * 24 + 10) : e.h }]);
                }
              }
              setEditing(null);
            }}
          />
        }
      >
        <Input multiline autoFocus value={editing?.text ?? ''} onChangeText={(text) => setEditing((ed) => (ed ? { ...ed, text } : ed))} accessibilityLabel="Edit text" />
      </Sheet>
    </View>
  );
}

function ToolButton({ icon, label, onPress, active, color, text }: { icon: string; label: string; onPress: () => void; active?: boolean; color?: string; text?: string }) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active }}
      style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? c.accentSoft : pressed ? c.hover : 'transparent' })}
    >
      {text ? (
        <T size={20} weight="bold" tone="ink2">
          {text}
        </T>
      ) : (
        <Icon name={icon} size={18} color={color ?? (active ? c.accentInk : c.ink2)} />
      )}
    </Pressable>
  );
}
