/**
 * A small RFC 4180 CSV reader for imports: quoted fields, doubled quotes, line breaks inside
 * quotes, CRLF or LF line endings, a UTF-8 byte-order mark, and comma, semicolon or tab
 * delimiters (detected from the header line, as spreadsheet exports vary by locale).
 */
export function parseCsv(text: string): string[][] {
  const input = text.replace(/^\uFEFF/, '');
  const headerLine = input.slice(0, input.search(/\r?\n|$/));
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of headerLine) if (ch in counts) counts[ch as keyof typeof counts]++;
  const [best, seen] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const delimiter = seen > 0 ? best : ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Drop blank lines.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/**
 * Read a date the way people write them in spreadsheets: 2026-09-25, 2026-09-25T10:00:00Z,
 * 9/25/2026 (month first, unless the first number can't be a month), 25.09.2026 or
 * "Sep 25, 2026". Returns YYYY-MM-DD or null.
 */
export function parseLooseDate(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = v.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const [a, b] = [+m[1], +m[2]];
    // Dots are day-first (25.09.2026); slashes month-first unless that's impossible.
    const dayFirst = v.includes('.') || a > 12;
    return dayFirst ? ymd(year, b, a) : ymd(year, a, b);
  }
  if (/[a-z]/i.test(v) && v.length <= 40) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) {
      const d = new Date(t);
      return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
    }
  }
  return null;
}

function ymd(y: number, mo: number, d: number) {
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}
