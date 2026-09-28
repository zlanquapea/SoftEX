import { readFile } from 'node:fs/promises';

/**
 * Server-side speech-to-text for meeting recordings. Any service that speaks the OpenAI
 * transcription API works: OpenAI itself, Groq, Azure OpenAI, or a self-hosted Whisper server
 * (faster-whisper-server, whisper.cpp's server, LocalAI) that keeps audio on your own machines.
 */
export interface TranscriptSegment {
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface SpeechToText {
  transcribe(input: { data: Buffer; mime: string; name: string; language?: string }): Promise<TranscriptSegment[]>;
}

export interface WhisperSettings {
  url: string;
  apiKey?: string;
  model?: string;
  language?: string;
}

export function createWhisperClient(settings: WhisperSettings): SpeechToText {
  return {
    async transcribe({ data, mime, name, language }) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(data)], { type: mime }), name);
      form.append('model', settings.model ?? 'whisper-1');
      form.append('response_format', 'verbose_json');
      if (language ?? settings.language) form.append('language', (language ?? settings.language)!);
      const res = await fetch(settings.url, {
        method: 'POST',
        headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(15 * 60_000),
      });
      if (!res.ok) throw new Error(`Transcription service answered ${res.status}`);
      const body = (await res.json()) as { text?: string; segments?: { start: number; end: number; text: string }[] };
      if (body.segments?.length) {
        return body.segments
          .map((s) => ({ start_ms: Math.round(s.start * 1000), end_ms: Math.round(s.end * 1000), text: s.text.trim() }))
          .filter((s) => s.text);
      }
      return body.text?.trim() ? [{ start_ms: 0, end_ms: 0, text: body.text.trim() }] : [];
    },
  };
}

export const readUpload = (path: string) => readFile(path);
