import { format } from 'node:util';

type Level = 'log' | 'info' | 'warn' | 'error';
const SEVERITY: Record<Level, string> = { log: 'INFO', info: 'INFO', warn: 'WARNING', error: 'ERROR' };

/** One JSON line per log call, in the shape Cloud Logging parses (severity, message, stack trace). */
export function jsonLogLine(level: Level, args: unknown[]) {
  const error = args.find((a): a is Error => a instanceof Error);
  const message = format(...args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : a)));
  return JSON.stringify({
    severity: SEVERITY[level],
    message,
    // Lets Cloud Error Reporting group exceptions.
    ...(error ? { '@type': 'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent' } : {}),
    time: new Date().toISOString(),
  });
}

/**
 * Switch console output to structured JSON (SOFTEX_LOG_FORMAT=json, the default on Cloud Run) so
 * Cloud Logging shows real severities instead of treating every line as INFO/ERROR by stream.
 */
export function useJsonLogs() {
  for (const level of Object.keys(SEVERITY) as Level[]) {
    console[level] = (...args: unknown[]) => {
      process.stdout.write(`${jsonLogLine(level, args)}\n`);
    };
  }
}
