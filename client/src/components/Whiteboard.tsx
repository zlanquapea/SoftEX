import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import * as Y from 'yjs';
import { LOCAL, type LiveDoc } from '../collab';
import { Icon } from './Icon';

/**
 * A collaborative whiteboard. Elements live in a Y.Map shared through the live-collaboration
 * store, so everyone sees changes as they happen; undo only reverts your own changes.
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
const TOOLS: { id: Tool; icon: string; label: string; key: string }[] = [
  { id: 'select', icon: 'cursor', label: 'Select and move', key: 'v' },
  { id: 'hand', icon: 'hand', label: 'Pan', key: 'h' },
  { id: 'sticky', icon: 'sticky', label: 'Sticky note', key: 's' },
  { id: 'rect', icon: 'square', label: 'Rectangle', key: 'r' },
  { id: 'ellipse', icon: 'circle', label: 'Ellipse', key: 'o' },
  { id: 'text', icon: 'type', label: 'Text', key: 't' },
  { id: 'arrow', icon: 'arrow', label: 'Arrow (drag between shapes to connect them)', key: 'a' },
  { id: 'pen', icon: 'pen', label: 'Pen', key: 'p' },
];

const newId = () => Math.random().toString(36).slice(2, 11);
/** Colours come from other people's edits: only plain hex colours are used. */
const safeColor = (c: unknown, fallback = '#2B2118') => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : fallback);
const boxable = (e: El) => e.type !== 'arrow' && e.type !== 'pen';

/** Where a line from a box's centre towards (tx, ty) leaves the box. */
function edgePoint(e: El, tx: number, ty: number) {
  const cx = e.x + e.w / 2;
  const cy = e.y + e.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  if (e.type === 'ellipse') {
    const t = 1 / Math.sqrt((dx * dx) / ((e.w / 2) ** 2) + (dy * dy) / ((e.h / 2) ** 2));
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

/** Wrap text to fit a width, roughly (SVG has no text wrapping). */
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

function ElementShape({ e: raw, byId, selected }: { e: El; byId: Map<string, El>; selected: boolean }) {
  const e = { ...raw, color: safeColor(raw.color, raw.type === 'sticky' ? STICKY[0] : INK[0]) };
  const stroke = selected ? 'var(--accent)' : undefined;
  switch (e.type) {
    case 'sticky':
    case 'rect':
    case 'ellipse':
    case 'text': {
      const size = e.type === 'text' ? 18 : 15;
      const lines = wrap(e.text ?? '', e.w - 16, size);
      const lh = size * 1.3;
      const top = e.type === 'text' ? e.y + size : e.y + e.h / 2 - ((lines.length - 1) * lh) / 2 + size * 0.35;
      return (
        <g data-id={e.id}>
          {e.type === 'sticky' && <rect x={e.x} y={e.y} width={e.w} height={e.h} rx={4} fill={e.color} filter="url(#wb-shadow)" stroke={stroke} strokeWidth={selected ? 2 : 0} />}
          {e.type === 'rect' && <rect x={e.x} y={e.y} width={e.w} height={e.h} rx={8} fill="var(--wb-fill)" stroke={stroke ?? e.color} strokeWidth={2} />}
          {e.type === 'ellipse' && <ellipse cx={e.x + e.w / 2} cy={e.y + e.h / 2} rx={e.w / 2} ry={e.h / 2} fill="var(--wb-fill)" stroke={stroke ?? e.color} strokeWidth={2} />}
          {e.type === 'text' && <rect x={e.x} y={e.y} width={e.w} height={e.h} fill="transparent" stroke={stroke ?? 'none'} strokeDasharray="4 3" />}
          <text x={e.type === 'text' ? e.x + 2 : e.x + e.w / 2} y={top} textAnchor={e.type === 'text' ? 'start' : 'middle'} fontSize={size} fill={e.type === 'sticky' ? '#2B2118' : e.type === 'text' ? e.color : 'var(--ink)'} className="wb-text">
            {lines.map((l, i) => (
              <tspan key={i} x={e.type === 'text' ? e.x + 2 : e.x + e.w / 2} dy={i ? lh : 0}>
                {l || ' '}
              </tspan>
            ))}
          </text>
        </g>
      );
    }
    case 'arrow': {
      const { x1, y1, x2, y2 } = arrowEnds(e, byId);
      return (
        <g data-id={e.id}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={14} />
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke ?? e.color} strokeWidth={2.5} markerEnd="url(#wb-arrow)" />
        </g>
      );
    }
    case 'pen': {
      const pts = e.points ?? [];
      const d = pts.reduce((acc, v, i) => (i % 2 ? acc : `${acc}${i ? 'L' : 'M'}${e.x + v} ${e.y + pts[i + 1]} `), '');
      return (
        <g data-id={e.id}>
          <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
          <path d={d} fill="none" stroke={stroke ?? e.color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      );
    }
  }
}

type Drag =
  | { kind: 'move'; start: { x: number; y: number }; origin: Map<string, El> }
  | { kind: 'resize'; id: string; start: { x: number; y: number }; origin: El }
  | { kind: 'pan'; start: { x: number; y: number }; view: { x: number; y: number } }
  | { kind: 'marquee'; start: { x: number; y: number }; now: { x: number; y: number } }
  | { kind: 'create'; id: string; start: { x: number; y: number } }
  | { kind: 'arrow'; id: string }
  | { kind: 'pen'; id: string; pts: number[]; origin: { x: number; y: number } };

export function Whiteboard({ live, title }: { live: LiveDoc; title: string }) {
  const doc = live.doc;
  const map = useMemo(() => doc.getMap<El>('elements'), [doc]);
  const undo = useMemo(() => new Y.UndoManager(map, { trackedOrigins: new Set([LOCAL]), captureTimeout: 400 }), [map]);
  const [els, setEls] = useState<El[]>(() => [...map.values()]);
  const [tool, setTool] = useState<Tool>('select');
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [view, setView] = useState({ x: 40, y: 40, zoom: 1 });
  const [color, setColor] = useState<{ sticky: string; ink: string }>({ sticky: STICKY[0], ink: INK[0] });
  const drag = useRef<Drag | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
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
      // Arrows attached to a removed shape go with it.
      for (const e of map.values()) if (e.type === 'arrow' && (ids.includes(e.from ?? '') || ids.includes(e.to ?? ''))) map.delete(e.id);
    }, LOCAL);

  const toWorld = (ev: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: (ev.clientX - r.left - view.x) / view.zoom, y: (ev.clientY - r.top - view.y) / view.zoom };
  };
  const hit = (target: EventTarget | null) => {
    const g = (target as Element | null)?.closest?.('[data-id]');
    return g ? byId.get(g.getAttribute('data-id')!) : undefined;
  };
  const shapeAt = (p: { x: number; y: number }, except?: string) =>
    [...sorted].reverse().find((e) => boxable(e) && e.id !== except && p.x >= e.x && p.x <= e.x + e.w && p.y >= e.y && p.y <= e.y + e.h);

  const onPointerDown = (ev: RPointerEvent<SVGSVGElement>) => {
    if (editing) return;
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    const p = toWorld(ev);
    const target = hit(ev.target);
    if (tool === 'hand' || ev.button === 1 || (ev.button === 0 && ev.altKey)) {
      drag.current = { kind: 'pan', start: { x: ev.clientX, y: ev.clientY }, view: { x: view.x, y: view.y } };
      return;
    }
    if ((ev.target as Element).getAttribute?.('data-handle')) {
      const id = selected[0];
      drag.current = { kind: 'resize', id, start: p, origin: byId.get(id)! };
      return;
    }
    if (tool === 'select' || readOnly) {
      if (target) {
        const next = ev.shiftKey ? [...new Set([...selected, target.id])] : selected.includes(target.id) ? selected : [target.id];
        setSelected(next);
        if (!readOnly) drag.current = { kind: 'move', start: p, origin: new Map(next.map((id) => [id, byId.get(id)!])) };
      } else {
        setSelected([]);
        drag.current = { kind: 'marquee', start: p, now: p };
      }
      return;
    }
    const id = newId();
    const z = topZ();
    setSelected([]);
    if (tool === 'arrow') {
      const from = shapeAt(p);
      set([{ id, type: 'arrow', x: p.x, y: p.y, x2: p.x, y2: p.y, w: 0, h: 0, from: from?.id ?? null, to: null, color: color.ink, z }]);
      drag.current = { kind: 'arrow', id };
    } else if (tool === 'pen') {
      set([{ id, type: 'pen', x: p.x, y: p.y, w: 1, h: 1, points: [0, 0], color: color.ink, z }]);
      drag.current = { kind: 'pen', id, pts: [0, 0], origin: p };
    } else {
      const size = tool === 'sticky' ? { w: 180, h: 140 } : tool === 'text' ? { w: 220, h: 34 } : { w: 1, h: 1 };
      const el: El = { id, type: tool, x: p.x, y: p.y, ...size, color: tool === 'sticky' ? color.sticky : color.ink, text: '', z };
      set([el]);
      setSelected([id]);
      if (tool === 'sticky' || tool === 'text') {
        setEditing(id);
        setTool('select');
      } else drag.current = { kind: 'create', id, start: p };
    }
  };

  const onPointerMove = (ev: RPointerEvent<SVGSVGElement>) => {
    const p = toWorld(ev);
    live.setPresence({ cursor: p });
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'pan') setView((v) => ({ ...v, x: d.view.x + ev.clientX - d.start.x, y: d.view.y + ev.clientY - d.start.y }));
    else if (d.kind === 'move') {
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      set([...d.origin.values()].map((o) => ({ ...o, x: o.x + dx, y: o.y + dy, ...(o.type === 'arrow' ? { x2: (o.x2 ?? o.x) + dx, y2: (o.y2 ?? o.y) + dy } : {}) })));
    } else if (d.kind === 'resize') {
      set([{ ...d.origin, w: Math.max(30, d.origin.w + p.x - d.start.x), h: Math.max(24, d.origin.h + p.y - d.start.y) }]);
    } else if (d.kind === 'create') {
      const e = byId.get(d.id);
      if (e) set([{ ...e, x: Math.min(p.x, d.start.x), y: Math.min(p.y, d.start.y), w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) }]);
    } else if (d.kind === 'arrow') {
      const e = byId.get(d.id);
      if (e) set([{ ...e, x2: p.x, y2: p.y }]);
    } else if (d.kind === 'pen') {
      d.pts.push(p.x - d.origin.x, p.y - d.origin.y);
      const e = byId.get(d.id);
      if (e && d.pts.length % 4 === 0) set([{ ...e, points: [...d.pts] }]);
    } else if (d.kind === 'marquee') {
      d.now = p;
      setMarquee({ x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) });
    }
  };

  const onPointerUp = (ev: RPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const p = toWorld(ev);
    if (d.kind === 'create') {
      const e = byId.get(d.id);
      // A click without dragging makes a default-sized shape.
      if (e && e.w < 8 && e.h < 8) set([{ ...e, w: 160, h: 100 }]);
      setTool('select');
    } else if (d.kind === 'arrow') {
      const e = byId.get(d.id);
      const to = shapeAt(p, e?.from ?? undefined);
      if (e) {
        if (!to && Math.hypot((e.x2 ?? 0) - e.x, (e.y2 ?? 0) - e.y) < 6 && !e.from) remove([e.id]);
        else set([{ ...e, to: to?.id ?? null, x2: p.x, y2: p.y }]);
      }
    } else if (d.kind === 'pen') {
      const e = byId.get(d.id);
      if (e) {
        const xs = d.pts.filter((_, i) => i % 2 === 0);
        const ys = d.pts.filter((_, i) => i % 2 === 1);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        set([{ ...e, x: e.x + minX, y: e.y + minY, w: Math.max(...xs) - minX || 1, h: Math.max(...ys) - minY || 1, points: d.pts.map((v, i) => v - (i % 2 ? minY : minX)) }]);
      }
    } else if (d.kind === 'marquee') {
      const m = { x: Math.min(d.start.x, d.now.x), y: Math.min(d.start.y, d.now.y), x2: Math.max(d.start.x, d.now.x), y2: Math.max(d.start.y, d.now.y) };
      if (m.x2 - m.x > 4 || m.y2 - m.y > 4) setSelected(els.filter((e) => e.type !== 'arrow' && e.x >= m.x && e.y >= m.y && e.x + e.w <= m.x2 && e.y + e.h <= m.y2).map((e) => e.id));
      setMarquee(null);
    }
  };

  const onWheel = (ev: React.WheelEvent) => {
    if (ev.ctrlKey || ev.metaKey) {
      const r = svg.current!.getBoundingClientRect();
      const mx = ev.clientX - r.left;
      const my = ev.clientY - r.top;
      setView((v) => {
        const zoom = Math.min(4, Math.max(0.2, v.zoom * Math.exp(-ev.deltaY / 300)));
        return { zoom, x: mx - ((mx - v.x) * zoom) / v.zoom, y: my - ((my - v.y) * zoom) / v.zoom };
      });
    } else setView((v) => ({ ...v, x: v.x - ev.deltaX, y: v.y - ev.deltaY }));
  };
  // Page scroll must not steal the wheel while over the board.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.preventDefault();
    el.addEventListener('wheel', stop, { passive: false });
    return () => el.removeEventListener('wheel', stop);
  }, []);

  const zoomBy = (f: number) => {
    const r = svg.current!.getBoundingClientRect();
    setView((v) => {
      const zoom = Math.min(4, Math.max(0.2, v.zoom * f));
      return { zoom, x: r.width / 2 - ((r.width / 2 - v.x) * zoom) / v.zoom, y: r.height / 2 - ((r.height / 2 - v.y) * zoom) / v.zoom };
    });
  };
  const fit = () => {
    const r = svg.current!.getBoundingClientRect();
    const b = bounds(els, byId);
    const zoom = Math.min(2, Math.max(0.2, Math.min((r.width - 80) / (b.w || 1), (r.height - 80) / (b.h || 1))));
    setView({ zoom, x: (r.width - b.w * zoom) / 2 - b.x * zoom, y: (r.height - b.h * zoom) / 2 - b.y * zoom });
  };

  // Keyboard: tools, delete, undo/redo, duplicate.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const typing = (ev.target as HTMLElement).closest?.('input, textarea, [contenteditable]');
      if (typing || editing) return;
      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        if (ev.shiftKey) undo.redo();
        else undo.undo();
      } else if (mod && ev.key.toLowerCase() === 'y') {
        ev.preventDefault();
        undo.redo();
      } else if (mod && ev.key.toLowerCase() === 'd' && selected.length && !readOnly) {
        ev.preventDefault();
        const copies = selected.map((id) => byId.get(id)!).filter(Boolean).map((e) => ({ ...e, id: newId(), x: e.x + 24, y: e.y + 24, x2: e.x2 !== undefined ? e.x2 + 24 : undefined, z: topZ() }));
        set(copies);
        setSelected(copies.map((c) => c.id));
      } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected.length && !readOnly) {
        ev.preventDefault();
        remove(selected);
        setSelected([]);
      } else if (ev.key === 'Escape') {
        setSelected([]);
        setTool('select');
      } else if (!mod && !readOnly) {
        const t = TOOLS.find((x) => x.key === ev.key.toLowerCase());
        if (t) setTool(t.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const exportSvg = () => {
    const b = bounds(els, byId);
    const clone = svg.current!.cloneNode(true) as SVGSVGElement;
    clone.querySelector('.wb-world')?.setAttribute('transform', '');
    clone.querySelectorAll('.wb-ui').forEach((n) => n.remove());
    clone.setAttribute('viewBox', `${b.x - 40} ${b.y - 40} ${b.w + 80} ${b.h + 80}`);
    clone.setAttribute('width', String(Math.round(b.w + 80)));
    clone.setAttribute('height', String(Math.round(b.h + 80)));
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const css = `.wb-text{font-family:system-ui,sans-serif}`;
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = css;
    clone.prepend(style);
    // Resolve theme colours so the file looks the same outside Küü.
    const vars = getComputedStyle(document.documentElement);
    const text = new XMLSerializer().serializeToString(clone).replace(/var\((--[\w-]+)\)/g, (_, v) => vars.getPropertyValue(v).trim() || '#000');
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^\w\- ]+/g, '').trim() || 'whiteboard'}.svg`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const sel = selected.map((id) => byId.get(id)).filter(Boolean) as El[];
  const single = sel.length === 1 ? sel[0] : null;
  const editingEl = editing ? byId.get(editing) : null;
  const peers = [...live.peers.values()].filter((p) => p.cursor);

  return (
    <div className="wb">
      <div className="wb-toolbar" role="toolbar" aria-label="Whiteboard tools">
        {TOOLS.filter((t) => !readOnly || t.id === 'select' || t.id === 'hand').map((t) => (
          <button key={t.id} className={`icon-btn ${tool === t.id ? 'active' : ''}`} aria-pressed={tool === t.id} aria-label={t.label} title={`${t.label} (${t.key.toUpperCase()})`} onClick={() => setTool(t.id)}>
            <Icon name={t.icon} size={18} />
          </button>
        ))}
        {!readOnly && (
          <>
            <span className="wb-sep" />
            <button className="icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)" onClick={() => undo.undo()}>
              <Icon name="undo" size={17} />
            </button>
            <button className="icon-btn" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" onClick={() => undo.redo()}>
              <Icon name="redo" size={17} />
            </button>
          </>
        )}
      </div>

      {!readOnly && (sel.length > 0 || tool !== 'select') && (
        <div className="wb-props" role="group" aria-label="Colour">
          {(single?.type === 'sticky' || (!single && tool === 'sticky') ? STICKY : INK).map((c) => (
            <button
              key={c}
              className="wb-swatch"
              style={{ background: c }}
              aria-label={`Colour ${c}`}
              onClick={() => {
                if (sel.length) set(sel.map((e) => ({ ...e, color: e.type === 'sticky' ? (STICKY.includes(c) ? c : e.color) : INK.includes(c) ? c : e.color })));
                setColor((cur) => (STICKY.includes(c) ? { ...cur, sticky: c } : { ...cur, ink: c }));
              }}
            />
          ))}
          {sel.length > 0 && (
            <>
              <span className="wb-sep" />
              <button className="icon-btn" aria-label="Bring to front" title="Bring to front" onClick={() => set(sel.map((e, i) => ({ ...e, z: topZ() + i })))}>
                <Icon name="layers" size={16} />
              </button>
              <button
                className="icon-btn"
                aria-label="Delete selection"
                onClick={() => {
                  remove(selected);
                  setSelected([]);
                }}
              >
                <Icon name="trash" size={16} />
              </button>
            </>
          )}
        </div>
      )}

      <div className="wb-zoom">
        <button className="icon-btn" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
          −
        </button>
        <button className="link-btn" onClick={() => setView((v) => ({ ...v, zoom: 1 }))} aria-label="Reset zoom">
          {Math.round(view.zoom * 100)}%
        </button>
        <button className="icon-btn" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
          +
        </button>
        <button className="icon-btn" aria-label="Fit to screen" title="Fit to screen" onClick={fit}>
          <Icon name="maximize" size={15} />
        </button>
        <button className="icon-btn" aria-label="Download as SVG" title="Download as SVG" onClick={exportSvg}>
          <Icon name="download" size={15} />
        </button>
      </div>

      <svg
        ref={svg}
        className={`wb-canvas tool-${tool}`}
        role="img"
        aria-label={`Whiteboard with ${els.length} item${els.length === 1 ? '' : 's'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => live.setPresence({ cursor: null })}
        onWheel={onWheel}
        onDoubleClick={(ev) => {
          if (readOnly) return;
          const target = hit(ev.target);
          if (target && boxable(target)) setEditing(target.id);
          else if (!target) {
            // Double-click on empty space adds a sticky note there.
            const p = toWorld(ev);
            const id = newId();
            set([{ id, type: 'sticky', x: p.x - 90, y: p.y - 70, w: 180, h: 140, color: color.sticky, text: '', z: topZ() }]);
            setSelected([id]);
            setEditing(id);
          }
        }}
      >
        <defs>
          <pattern id="wb-grid" width={24 * view.zoom} height={24 * view.zoom} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
            <circle cx={1} cy={1} r={1} fill="var(--line)" />
          </pattern>
          <marker id="wb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="context-stroke" />
          </marker>
          <filter id="wb-shadow" x="-10%" y="-10%" width="130%" height="140%">
            <feDropShadow dx="0" dy="2" stdDeviation="2.5" floodOpacity="0.18" />
          </filter>
        </defs>
        <rect className="wb-ui" x={0} y={0} width="100%" height="100%" fill="url(#wb-grid)" />
        <g className="wb-world" transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
          {sorted.map((e) => (
            <ElementShape key={e.id} e={e} byId={byId} selected={selected.includes(e.id)} />
          ))}
          {single && boxable(single) && !readOnly && (
            <rect className="wb-ui wb-handle" data-handle="1" x={single.x + single.w - 6 / view.zoom} y={single.y + single.h - 6 / view.zoom} width={12 / view.zoom} height={12 / view.zoom} />
          )}
          {marquee && <rect className="wb-ui wb-marquee" x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} />}
          {peers.map((p) => (
            <g key={p.clientId} className="wb-ui wb-cursor" transform={`translate(${p.cursor!.x} ${p.cursor!.y}) scale(${1 / view.zoom})`} style={{ color: `var(--c-${p.user.color}, var(--accent))` }}>
              <path d="M0 0 L0 16 L4.5 12 L8 19 L10.5 18 L7 11 L13 11 z" fill="currentColor" stroke="#fff" strokeWidth="1" />
              <text x={14} y={24} className="wb-cursor-name" fill="currentColor">
                {p.user.name}
              </text>
            </g>
          ))}
        </g>
      </svg>

      {editingEl && (
        <textarea
          className="wb-editor"
          autoFocus
          aria-label="Edit text"
          defaultValue={editingEl.text ?? ''}
          style={{
            left: view.x + editingEl.x * view.zoom,
            top: view.y + editingEl.y * view.zoom,
            width: editingEl.w * view.zoom,
            height: Math.max(editingEl.h, 34) * view.zoom,
            fontSize: (editingEl.type === 'text' ? 18 : 15) * view.zoom,
            background: editingEl.type === 'sticky' ? safeColor(editingEl.color, STICKY[0]) : 'var(--surface)',
          }}
          onKeyDown={(ev) => {
            if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey))) (ev.target as HTMLTextAreaElement).blur();
          }}
          onBlur={(ev) => {
            const text = ev.target.value;
            const e = byId.get(editingEl.id);
            if (e) {
              if (!text.trim() && e.type === 'text') remove([e.id]);
              else {
                const lines = wrap(text, e.w - 16, e.type === 'text' ? 18 : 15).length;
                set([{ ...e, text, h: e.type === 'text' ? Math.max(34, lines * 24 + 10) : e.h }]);
              }
            }
            setEditing(null);
          }}
        />
      )}
      {!els.length && !readOnly && (
        <p className="wb-hint muted">
          Pick a tool above, or double-click anywhere to add a sticky note. Drag with the hand tool (or hold Alt) to move around; Ctrl + scroll to zoom.
        </p>
      )}
    </div>
  );
}
