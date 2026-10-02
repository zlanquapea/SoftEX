import { describe, expect, it } from 'vitest';
import { jsonLogLine } from '../src/logging.js';

describe('structured logs', () => {
  it('maps console levels to Cloud Logging severities', () => {
    expect(JSON.parse(jsonLogLine('warn', ['careful'])).severity).toBe('WARNING');
    expect(JSON.parse(jsonLogLine('log', ['hello', 3])).message).toBe('hello 3');
  });

  it('includes the stack trace so errors are grouped', () => {
    const line = JSON.parse(jsonLogLine('error', ['Background job failed', new Error('boom')]));
    expect(line.severity).toBe('ERROR');
    expect(line.message).toContain('Error: boom');
    expect(line['@type']).toMatch(/ReportedErrorEvent/);
  });
});
