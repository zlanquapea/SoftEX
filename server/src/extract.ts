import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/**
 * Full-text extraction for search (§5.3 "search ... including files where
 * extraction is supported"). Plain-text formats are read directly; Office Open
 * XML (docx/pptx/xlsx) and OpenDocument files are unzipped and their XML text
 * nodes collected. Other formats (PDF, images) are indexed by name only.
 */
const MAX_TEXT = 200_000;
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.yaml', '.yml', '.xml', '.html', '.htm', '.rtf']);

export function extractText(path: string, name: string): string | null {
  const ext = extname(name).toLowerCase();
  try {
    const data = readFileSync(path);
    if (TEXT_EXT.has(ext)) {
      let text = data.subarray(0, 2 * MAX_TEXT).toString('utf8');
      if (ext === '.html' || ext === '.htm' || ext === '.xml') text = stripXml(text);
      if (ext === '.rtf') text = text.replace(/\\[a-z]+-?\d* ?|[{}]/g, ' ');
      return normalise(text);
    }
    if (['.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods'].includes(ext)) {
      const entries = readZip(data);
      const wanted = [...entries.keys()].filter((n) =>
        ext === '.docx'
          ? /^word\/(document|header\d*|footer\d*)\.xml$/.test(n)
          : ext === '.pptx'
            ? /^ppt\/slides\/slide\d+\.xml$/.test(n)
            : ext === '.xlsx'
              ? n === 'xl/sharedStrings.xml'
              : n === 'content.xml',
      );
      wanted.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return normalise(wanted.map((n) => stripXml(entries.get(n)!().toString('utf8'))).join('\n'));
    }
  } catch {
    return null;
  }
  return null;
}

const normalise = (t: string) => t.replace(/[ \t\r\f\v]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, MAX_TEXT);

function stripXml(xml: string) {
  return xml
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(w:p|a:p|text:p|p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Tiny ZIP reader (central directory + stored/deflate entries), enough for Office files. */
export function readZip(buf: Buffer): Map<string, () => Buffer> {
  const out = new Map<string, () => Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    out.set(name, () => {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw, { maxOutputLength: 20 * 1024 * 1024 });
      throw new Error(`Unsupported zip method ${method}`);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
