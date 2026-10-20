import { NOTES_JSON_SCHEMA } from './notes.ts';
import { parseTranscriptionResponse, type ParsedTranscript } from './transcript.ts';

/** An error whose message is safe to show to the end user (never contains secrets). */
export class UserFacingError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'UserFacingError';
    this.status = status;
  }
}

/** Maps provider HTTP failures to short, secret-free messages. */
export function describeProviderFailure(provider: string, status: number): string {
  if (status === 401 || status === 403) {
    return `The ${provider} credentials configured on the server were rejected. The app operator needs to check the API key.`;
  }
  if (status === 429) return `${provider} is rate-limiting requests right now. Please retry in a minute.`;
  if (status === 413) return `The audio file is too large for ${provider}.`;
  if (status >= 500) return `${provider} is temporarily unavailable. Please retry shortly.`;
  return `${provider} could not process the request (HTTP ${status}).`;
}

export type SpeechProvider = 'openai' | 'groq';
export type NotesProvider = 'anthropic' | 'openai' | 'groq';

/** Groq speaks the OpenAI wire format; only the host differs. */
export const PROVIDER_BASE_URL: Record<'openai' | 'groq', string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
};

export const PROVIDER_LABEL: Record<NotesProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI', groq: 'Groq' };

/** Default models per provider (override with TRANSCRIPTION_MODEL / SUMMARY_MODEL). */
export const DEFAULT_TRANSCRIPTION_MODEL: Record<SpeechProvider, string> = { openai: 'whisper-1', groq: 'whisper-large-v3' };
export const DEFAULT_NOTES_MODEL: Record<NotesProvider, string> = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-4o-mini',
  groq: 'llama-3.3-70b-versatile',
};

export function readSpeechProvider(value: string | undefined | null): SpeechProvider {
  return value === 'groq' ? 'groq' : 'openai';
}

export function readNotesProvider(value: string | undefined | null): NotesProvider {
  return value === 'openai' || value === 'groq' ? value : 'anthropic';
}

export interface TranscribeParams {
  /** Which service to call. Defaults to OpenAI. */
  provider?: SpeechProvider;
  apiKey: string;
  model: string;
  file: Blob;
  fileName: string;
  /** 'auto' or an ISO-639-1 code */
  language: string;
  fetchImpl?: typeof fetch;
}

/**
 * Audio transcription through OpenAI or Groq (same API shape). whisper-1 and Groq's whisper-large-v3 family return segment
 * timestamps; newer OpenAI models return text only.
 */
export async function transcribeWithOpenAI(params: TranscribeParams): Promise<ParsedTranscript> {
  const { provider = 'openai', apiKey, model, file, fileName, language, fetchImpl = fetch } = params;
  const supportsSegments = model === 'whisper-1' || /^whisper-large-v3/.test(model);
  const form = new FormData();
  form.append('file', file, fileName);
  form.append('model', model);
  form.append('response_format', supportsSegments ? 'verbose_json' : 'json');
  if (supportsSegments) form.append('timestamp_granularities[]', 'segment');
  if (language && language !== 'auto') form.append('language', language.split('-')[0] ?? language);

  let response: Response;
  try {
    response = await fetchImpl(`${PROVIDER_BASE_URL[provider]}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
  } catch {
    throw new UserFacingError('Could not reach the transcription provider. Please retry.', 502);
  }
  if (!response.ok) throw new UserFacingError(describeProviderFailure('The transcription provider', response.status), 502);

  try {
    return parseTranscriptionResponse(await response.json());
  } catch (error) {
    throw new UserFacingError(error instanceof Error ? error.message : 'Unreadable transcription response.', 502);
  }
}

export interface StructuredParams {
  provider: NotesProvider;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  /** JSON Schema of the object the model must return. */
  schema: object;
  /** Tool / schema name (letters, digits, "_" and "-"). */
  schemaName: string;
  toolDescription: string;
  fetchImpl?: typeof fetch;
}

/**
 * Asks the model for one structured object. Anthropic: forced tool use. OpenAI: strict JSON
 * schema output. Returns the raw (untrusted) object; callers must validate it.
 */
export async function structuredWithProvider(params: StructuredParams): Promise<unknown> {
  const { provider, apiKey, model, system, user, schema, schemaName, toolDescription, fetchImpl = fetch } = params;
  const label = PROVIDER_LABEL[provider];

  let response: Response;
  try {
    if (provider === 'anthropic') {
      response = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system,
          messages: [{ role: 'user', content: user }],
          tools: [{ name: schemaName, description: toolDescription, input_schema: schema }],
          tool_choice: { type: 'tool', name: schemaName },
        }),
        signal: AbortSignal.timeout(5 * 60 * 1000),
      });
    } else if (provider === 'groq') {
      // JSON-object mode works on every Groq model; the schema is given in the prompt and the result is validated by the caller.
      response = await fetchImpl(`${PROVIDER_BASE_URL.groq}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: `${system}\n\nReturn ONLY one JSON object that follows this JSON Schema:\n${JSON.stringify(schema)}` },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(5 * 60 * 1000),
      });
    } else {
      response = await fetchImpl(`${PROVIDER_BASE_URL.openai}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
        }),
        signal: AbortSignal.timeout(5 * 60 * 1000),
      });
    }
  } catch {
    throw new UserFacingError(`Could not reach ${label}. Please retry.`, 502);
  }
  if (!response.ok) throw new UserFacingError(describeProviderFailure(label, response.status), 502);

  const data = (await response.json()) as Record<string, unknown>;
  if (provider === 'anthropic') {
    const content = Array.isArray(data.content) ? (data.content as Array<Record<string, unknown>>) : [];
    const block = content.find((b) => b.type === 'tool_use');
    if (!block || typeof block.input !== 'object') {
      throw new UserFacingError('The AI provider did not return structured output.', 502);
    }
    return block.input;
  }
  const choices = Array.isArray(data.choices) ? (data.choices as Array<{ message?: { content?: unknown } }>) : [];
  const content = choices[0]?.message?.content;
  if (typeof content !== 'string') throw new UserFacingError('The AI provider did not return a result.', 502);
  try {
    return JSON.parse(content);
  } catch {
    throw new UserFacingError('The AI provider returned a result that could not be read.', 502);
  }
}

export interface SummarizeParams {
  provider: NotesProvider;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  fetchImpl?: typeof fetch;
}

/** Notes generation: returns the raw (untrusted) notes object produced by the model. */
export function summarizeWithProvider(params: SummarizeParams): Promise<unknown> {
  return structuredWithProvider({
    ...params,
    schema: NOTES_JSON_SCHEMA,
    schemaName: 'record_notes',
    toolDescription: 'Record the structured notes for this recording.',
  });
}
