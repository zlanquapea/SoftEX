import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Fragment, type ReactNode } from 'react';
import { Platform, Text, View } from 'react-native';
import { fonts, useTheme, type Palette } from '../lib/theme';
import { Checkbox } from './kit';

/**
 * The web app's small, safe Markdown subset, rendered with native Text: bold, italic,
 * code, links, @mentions, lists and checklists, quotes, code blocks and headings.
 * Links are limited to http(s) and in-app paths.
 */

export function openLink(href: string) {
  if (/^\/(?![/\\])[^\s]*$/.test(href)) return router.push(href as never);
  try {
    const url = new URL(href);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (Platform.OS === 'web') globalThis.open?.(url.href, '_blank', 'noopener');
      else WebBrowser.openBrowserAsync(url.href);
    }
  } catch {
    /* not a link */
  }
}

function inline(text: string, keyBase: string, c: Palette): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(@\[[^\]]+\]\([0-9a-f-]{36}\))|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}-${i++}`;
    const token = m[0];
    if (m[1])
      out.push(
        <Text key={k} style={{ fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), backgroundColor: c.line2, fontSize: 13.5 }}>
          {token.slice(1, -1)}
        </Text>,
      );
    else if (m[2])
      out.push(
        <Text key={k} style={{ fontFamily: fonts.bold }}>
          {inline(token.slice(2, -2), k, c)}
        </Text>,
      );
    else if (m[3])
      out.push(
        <Text key={k} style={{ fontStyle: 'italic' }}>
          {inline(token.slice(1, -1), k, c)}
        </Text>,
      );
    else if (m[4]) {
      const [, name, id] = token.match(/@\[([^\]]+)\]\(([^)]+)\)/)!;
      out.push(
        <Text key={k} style={{ color: c.accentInk, fontFamily: fonts.semibold, backgroundColor: c.accentSoft }} onPress={() => router.push(`/people/${id}` as never)}>
          @{name}
        </Text>,
      );
    } else if (m[5]) {
      const [, label, href] = token.match(/\[([^\]]+)\]\(([^)]+)\)/)!;
      out.push(link(href, label, k, c));
    } else if (m[6]) out.push(link(token, token, k, c));
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function link(href: string, label: string, key: string, c: Palette) {
  const ok = /^\/(?![/\\])[^\s]*$/.test(href) || /^https?:\/\//i.test(href);
  if (!ok) return <Fragment key={key}>{label}</Fragment>;
  return (
    <Text key={key} style={{ color: c.accentInk, textDecorationLine: 'underline' }} onPress={() => openLink(href)} accessibilityRole="link">
      {label}
    </Text>
  );
}

export function Markdown({ text, compact = false, size = 15, color }: { text: string; compact?: boolean; size?: number; color?: string }) {
  const { c } = useTheme();
  const base = { fontFamily: fonts.body, fontSize: size, lineHeight: Math.round(size * 1.45), color: color ?? c.ink };
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      blocks.push(
        <View key={key++} style={{ backgroundColor: c.sunken, borderRadius: 8, padding: 10 }}>
          <Text style={{ fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 13, color: c.ink }}>{code.join('\n')}</Text>
        </View>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading && !compact) {
      const level = heading[1].length;
      blocks.push(
        <Text key={key++} accessibilityRole="header" style={[base, { fontFamily: fonts.display, fontSize: [0, 21, 18, 16][level], lineHeight: [0, 28, 24, 22][level], marginTop: 4 }]}>
          {inline(heading[2], `h${key}`, c)}
        </Text>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: ReactNode[] = [];
      let n = 0;
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const ordered = /^\s*\d+\./.test(lines[i]);
        const itemText = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '');
        const box = itemText.match(/^\[( |x)\]\s+(.*)$/i);
        n++;
        items.push(
          <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: box ? 'center' : 'flex-start' }}>
            {box ? <Checkbox checked={box[1].toLowerCase() === 'x'} disabled /> : <Text style={[base, { width: ordered ? 20 : 12, color: c.muted }]}>{ordered ? `${n}.` : '•'}</Text>}
            <Text style={[base, { flex: 1 }]}>{inline(box ? box[2] : itemText, `li${i}`, c)}</Text>
          </View>,
        );
        i++;
      }
      blocks.push(
        <View key={key++} style={{ gap: 3 }}>
          {items}
        </View>,
      );
      continue;
    }
    if (line.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) quote.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(
        <View key={key++} style={{ borderLeftWidth: 3, borderColor: c.accentLine, paddingLeft: 10 }}>
          <Text style={[base, { color: c.ink2 }]}>{inline(quote.join(' '), `q${key}`, c)}</Text>
        </View>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,3}\s|>|\s*([-*]|\d+\.)\s+)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    blocks.push(
      <Text key={key++} style={base}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && '\n'}
            {inline(p, `p${key}-${j}`, c)}
          </Fragment>
        ))}
      </Text>,
    );
  }
  return <View style={{ gap: compact ? 4 : 8 }}>{blocks}</View>;
}
