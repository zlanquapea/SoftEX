import { describe, expect, it } from 'vitest';
import { plainPreview } from './format';

describe('plainPreview', () => {
  it('shows a message as plain text for conversation previews', () => {
    expect(plainPreview('**Office closed Monday** for the holiday')).toBe('Office closed Monday for the holiday');
    expect(plainPreview('Ask @[Maya Singh](0b7e6c2a-1d2e-4f5a-9b8c-7d6e5f4a3b2c) about `deploy`')).toBe('Ask @Maya Singh about deploy');
    expect(plainPreview('See [the brief](https://example.com/brief) and _notes_')).toBe('See the brief and notes');
    expect(plainPreview('- first\n- second')).toBe('first second');
    expect(plainPreview('```\nconst x = 1\n```\nDone')).toBe('[code] Done');
    // Snake_case and file names keep their underscores.
    expect(plainPreview('rename my_file_name.ts')).toBe('rename my_file_name.ts');
  });
});
