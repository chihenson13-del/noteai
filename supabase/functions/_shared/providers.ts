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

export interface TranscribeParams {
  apiKey: string;
  model: string;
  file: Blob;
  fileName: string;
  /** 'auto' or an ISO-639-1 code */
  language: string;
  fetchImpl?: typeof fetch;
}

/** OpenAI audio transcription. whisper-1 returns segment timestamps; newer models return text only. */
export async function transcribeWithOpenAI(params: TranscribeParams): Promise<ParsedTranscript> {
  const { apiKey, model, file, fileName, language, fetchImpl = fetch } = params;
  const supportsSegments = model === 'whisper-1';
  const form = new FormData();
  form.append('file', file, fileName);
  form.append('model', model);
  form.append('response_format', supportsSegments ? 'verbose_json' : 'json');
  if (supportsSegments) form.append('timestamp_granularities[]', 'segment');
  if (language && language !== 'auto') form.append('language', language.split('-')[0] ?? language);

  let response: Response;
  try {
    response = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
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
  provider: 'anthropic' | 'openai';
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
  const label = provider === 'anthropic' ? 'Anthropic' : 'OpenAI';

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
    } else {
      response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
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
  provider: 'anthropic' | 'openai';
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
