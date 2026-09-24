import Anthropic from '@anthropic-ai/sdk';
import type { AiClient } from './context.js';

/**
 * Claude-backed implementation of the AiClient used by the governed AI features
 * (§5.6). Enabled only when ANTHROPIC_API_KEY is set on the server AND an admin
 * turns AI on for the workspace.
 */
export function createClaudeClient(apiKey: string, model: string): AiClient {
  const client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 });
  return {
    async complete({ system, prompt, jsonSchema }) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 8000,
        // If the primary model declines, let the API retry on its recommended fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: {
          effort: 'medium',
          ...(jsonSchema ? { format: { type: 'json_schema', schema: jsonSchema } } : {}),
        },
        system,
        messages: [{ role: 'user', content: prompt }],
      });
      if (response.stop_reason === 'refusal') return { text: '', refused: true };
      const text = response.content
        .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      return { text, refused: false };
    },
  };
}
