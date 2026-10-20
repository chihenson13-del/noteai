// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NOTES_MODEL,
  DEFAULT_TRANSCRIPTION_MODEL,
  UserFacingError,
  readNotesProvider,
  readSpeechProvider,
  summarizeWithProvider,
  transcribeWithOpenAI,
} from './providers.ts';

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('Groq as a provider', () => {
  it('reads provider names safely, defaulting to the original providers', () => {
    expect(readSpeechProvider('groq')).toBe('groq');
    expect(readSpeechProvider(undefined)).toBe('openai');
    expect(readSpeechProvider('anything else')).toBe('openai');
    expect(readNotesProvider('groq')).toBe('groq');
    expect(readNotesProvider('openai')).toBe('openai');
    expect(readNotesProvider(undefined)).toBe('anthropic');
    expect(DEFAULT_TRANSCRIPTION_MODEL.groq).toBe('whisper-large-v3');
    expect(DEFAULT_NOTES_MODEL.groq).toBe('llama-3.3-70b-versatile');
  });

  it('transcribes on Groq with segment timestamps', async () => {
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
      const form = init?.body as FormData;
      expect(form.get('model')).toBe('whisper-large-v3');
      expect(form.get('response_format')).toBe('verbose_json');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer gsk-test');
      return okJson({ text: 'Hello there', language: 'english', segments: [{ start: 0, end: 2, text: 'Hello there' }] });
    });
    const result = await transcribeWithOpenAI({
      provider: 'groq',
      apiKey: 'gsk-test',
      model: 'whisper-large-v3',
      file: new Blob(['a']),
      fileName: 'a.webm',
      language: 'auto',
      fetchImpl: fetchImpl as never,
    });
    expect(result.segments).toHaveLength(1);
  });

  it('still calls OpenAI by default', async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      expect(String(url)).toBe('https://api.openai.com/v1/audio/transcriptions');
      return okJson({ text: 'Hi', segments: [] });
    });
    await transcribeWithOpenAI({ apiKey: 'k', model: 'whisper-1', file: new Blob(['a']), fileName: 'a.webm', language: 'auto', fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('asks Groq for a JSON object with the schema in the prompt, and parses the answer', async () => {
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.groq.com/openai/v1/chat/completions');
      const body = JSON.parse(String(init?.body));
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.messages[0].content).toMatch(/JSON Schema/);
      expect(body.messages[0].content).toMatch(/summary/);
      return okJson({ choices: [{ message: { content: '{"summary":"S"}' } }] });
    });
    const out = await summarizeWithProvider({ provider: 'groq', apiKey: 'gsk', model: 'llama-3.3-70b-versatile', system: 'sys', user: 'u', fetchImpl: fetchImpl as never });
    expect(out).toEqual({ summary: 'S' });
  });

  it('names Groq (not OpenAI) in user-facing errors without leaking the key', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":{"message":"Invalid API Key gsk_live_secret"}}', { status: 401 }));
    const error = await summarizeWithProvider({ provider: 'groq', apiKey: 'gsk_live_secret', model: 'm', system: 's', user: 'u', fetchImpl: fetchImpl as never }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserFacingError);
    expect((error as Error).message).toMatch(/Groq/);
    expect((error as Error).message).not.toMatch(/gsk_live_secret/);
  });
});
