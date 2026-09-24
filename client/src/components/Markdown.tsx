import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * A small, safe Markdown renderer. It never injects HTML: every node is built
 * with React elements, and links are limited to http(s) and in-app paths.
 */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(@\[[^\]]+\]\([0-9a-f-]{36}\))|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}-${i++}`;
    const token = m[0];
    if (m[1]) out.push(<code key={k}>{token.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(token.slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<em key={k}>{inline(token.slice(1, -1), k)}</em>);
    else if (m[4]) {
      const [, name, id] = token.match(/@\[([^\]]+)\]\(([^)]+)\)/)!;
      out.push(
        <Link key={k} className="mention" to={`/people/${id}`}>
          @{name}
        </Link>,
      );
    } else if (m[5]) {
      const [, label, href] = token.match(/\[([^\]]+)\]\(([^)]+)\)/)!;
      out.push(linkEl(href, label, k));
    } else if (m[6]) out.push(linkEl(token, token, k));
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function linkEl(href: string, label: string, key: string) {
  if (href.startsWith('/') && !href.startsWith('//')) {
    return (
      <Link key={key} to={href}>
        {label}
      </Link>
    );
  }
  if (/^https?:\/\//i.test(href)) {
    return (
      <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">
        {label}
      </a>
    );
  }
  return <Fragment key={key}>{label}</Fragment>;
}

export function Markdown({ text, compact = false }: { text: string; compact?: boolean }) {
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
        <pre key={key++}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading && !compact) {
      const level = heading[1].length;
      const content = inline(heading[2], `h${key}`);
      blocks.push(level === 1 ? <h2 key={key++}>{content}</h2> : level === 2 ? <h3 key={key++}>{content}</h3> : <h4 key={key++}>{content}</h4>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '');
        const box = itemText.match(/^\[( |x)\]\s+(.*)$/i);
        items.push(
          <li key={i} className={box ? 'checkbox-item' : undefined}>
            {box ? <input type="checkbox" checked={box[1].toLowerCase() === 'x'} readOnly aria-label="checklist item" /> : null}
            {inline(box ? box[2] : itemText, `li${i}`)}
          </li>,
        );
        i++;
      }
      blocks.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
      continue;
    }
    if (line.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) quote.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={key++}>{inline(quote.join(' '), `q${key}`)}</blockquote>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,3}\s|>|\s*([-*]|\d+\.)\s+)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) {
      para.push(lines[i++]);
    }
    blocks.push(
      <p key={key++}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p, `p${key}-${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className={`markdown ${compact ? 'compact' : ''}`}>{blocks}</div>;
}
