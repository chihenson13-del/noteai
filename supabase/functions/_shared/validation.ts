export type SummaryLength = 'brief' | 'standard' | 'detailed';

export interface ProcessOptions {
  language: string;
  summaryLength: SummaryLength;
  extractActionItems: boolean;
  extractDecisions: boolean;
}

export interface ProcessRequest {
  recordingId: string;
  stage: 'all' | 'summarize';
  force: boolean;
  options: ProcessOptions;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANGUAGE = /^(auto|[a-z]{2,3}(-[A-Za-z0-9]{2,8})?)$/;

/** Validates the untrusted JSON body of a process-recording request. */
export function parseProcessRequest(body: unknown): ParseResult<ProcessRequest> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }
  const input = body as Record<string, unknown>;

  if (typeof input.recordingId !== 'string' || !UUID.test(input.recordingId)) {
    return { ok: false, error: 'recordingId must be a UUID.' };
  }
  const stage = input.stage ?? 'all';
  if (stage !== 'all' && stage !== 'summarize') {
    return { ok: false, error: 'stage must be "all" or "summarize".' };
  }
  const force = input.force === undefined ? false : input.force;
  if (typeof force !== 'boolean') return { ok: false, error: 'force must be a boolean.' };

  const raw = (input.options ?? {}) as Record<string, unknown>;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'options must be an object.' };
  }
  const language = raw.language ?? 'auto';
  if (typeof language !== 'string' || !LANGUAGE.test(language)) {
    return { ok: false, error: 'options.language must be "auto" or a language code.' };
  }
  const summaryLength = raw.summaryLength ?? 'standard';
  if (summaryLength !== 'brief' && summaryLength !== 'standard' && summaryLength !== 'detailed') {
    return { ok: false, error: 'options.summaryLength must be brief, standard or detailed.' };
  }
  const extractActionItems = raw.extractActionItems ?? true;
  const extractDecisions = raw.extractDecisions ?? true;
  if (typeof extractActionItems !== 'boolean' || typeof extractDecisions !== 'boolean') {
    return { ok: false, error: 'options.extractActionItems and options.extractDecisions must be booleans.' };
  }

  return {
    ok: true,
    value: {
      recordingId: input.recordingId.toLowerCase(),
      stage,
      force,
      options: { language, summaryLength, extractActionItems, extractDecisions },
    },
  };
}

export interface AskRequest {
  question: string;
  /** Restrict to these recordings; undefined = whole library. */
  recordingIds?: string[];
  /** Only recordings from the last N days. */
  sinceDays?: number;
}

export function parseAskRequest(body: unknown): ParseResult<AskRequest> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }
  const input = body as Record<string, unknown>;
  if (typeof input.question !== 'string') return { ok: false, error: 'question must be text.' };
  const question = input.question.replace(/\s+/g, ' ').trim();
  if (question.length < 3) return { ok: false, error: 'Ask a longer question.' };
  if (question.length > 500) return { ok: false, error: 'Questions can be up to 500 characters.' };

  let recordingIds: string[] | undefined;
  if (input.recordingIds !== undefined) {
    if (!Array.isArray(input.recordingIds) || input.recordingIds.length > 50) {
      return { ok: false, error: 'recordingIds must be a list of at most 50 ids.' };
    }
    if (!input.recordingIds.every((id) => typeof id === 'string' && UUID.test(id))) {
      return { ok: false, error: 'recordingIds must be UUIDs.' };
    }
    recordingIds = (input.recordingIds as string[]).map((id) => id.toLowerCase());
  }
  let sinceDays: number | undefined;
  if (input.sinceDays !== undefined) {
    if (typeof input.sinceDays !== 'number' || !Number.isInteger(input.sinceDays) || input.sinceDays < 1 || input.sinceDays > 3650) {
      return { ok: false, error: 'sinceDays must be a whole number of days.' };
    }
    sinceDays = input.sinceDays;
  }
  return { ok: true, value: { question, recordingIds, sinceDays } };
}

/**
 * Notes made on the device (on-device transcription) have no row in `recordings`, so the browser sends the notes it
 * wants to share. Everything is re-sanitised by buildShareSnapshot; this only checks the shape.
 */
export interface DeviceShare {
  title: string;
  recordedAt: string;
  durationMs: number;
  notes: {
    summary: string;
    keyTakeaways: unknown;
    decisions: unknown;
    chapters: unknown;
    provider: string;
    model: string;
    userEdited: boolean;
  };
  actionItems: Array<{ text: string; assignee: string | null; dueDate: string | null; done: boolean }>;
}

export type ShareRequest =
  | { action: 'create'; recordingId: string; expiresInDays: 1 | 7 | 30; device?: DeviceShare }
  | { action: 'list'; recordingId: string }
  | { action: 'revoke'; shareId: string };

function parseDeviceShare(raw: unknown): ParseResult<DeviceShare> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'device must be an object.' };
  const input = raw as Record<string, unknown>;
  if (typeof input.title !== 'string') return { ok: false, error: 'device.title must be text.' };
  if (typeof input.recordedAt !== 'string' || Number.isNaN(Date.parse(input.recordedAt))) {
    return { ok: false, error: 'device.recordedAt must be a date.' };
  }
  if (typeof input.durationMs !== 'number' || !Number.isFinite(input.durationMs) || input.durationMs < 0) {
    return { ok: false, error: 'device.durationMs must be a number.' };
  }
  const notes = input.notes;
  if (typeof notes !== 'object' || notes === null || Array.isArray(notes)) return { ok: false, error: 'device.notes must be an object.' };
  const n = notes as Record<string, unknown>;
  if (typeof n.summary !== 'string') return { ok: false, error: 'device.notes.summary must be text.' };
  if (!Array.isArray(input.actionItems) || input.actionItems.length > 100) {
    return { ok: false, error: 'device.actionItems must be a list.' };
  }
  const actionItems: DeviceShare['actionItems'] = [];
  for (const entry of input.actionItems) {
    if (typeof entry !== 'object' || entry === null) return { ok: false, error: 'device.actionItems has an invalid entry.' };
    const a = entry as Record<string, unknown>;
    if (typeof a.text !== 'string') return { ok: false, error: 'device.actionItems text must be text.' };
    actionItems.push({
      text: a.text,
      assignee: typeof a.assignee === 'string' ? a.assignee : null,
      dueDate: typeof a.dueDate === 'string' ? a.dueDate : null,
      done: a.done === true,
    });
  }
  return {
    ok: true,
    value: {
      title: input.title,
      recordedAt: new Date(input.recordedAt).toISOString(),
      durationMs: input.durationMs,
      notes: {
        summary: n.summary,
        keyTakeaways: n.keyTakeaways,
        decisions: n.decisions,
        chapters: n.chapters,
        provider: typeof n.provider === 'string' ? n.provider : '',
        model: typeof n.model === 'string' ? n.model : '',
        userEdited: n.userEdited === true,
      },
      actionItems,
    },
  };
}

export function parseShareRequest(body: unknown): ParseResult<ShareRequest> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }
  const input = body as Record<string, unknown>;
  if (input.action === 'create') {
    if (typeof input.recordingId !== 'string' || !UUID.test(input.recordingId)) {
      return { ok: false, error: 'recordingId must be a UUID.' };
    }
    const days = input.expiresInDays;
    if (days !== 1 && days !== 7 && days !== 30) return { ok: false, error: 'expiresInDays must be 1, 7 or 30.' };
    if (input.device === undefined) {
      return { ok: true, value: { action: 'create', recordingId: input.recordingId.toLowerCase(), expiresInDays: days } };
    }
    const device = parseDeviceShare(input.device);
    if (!device.ok) return device;
    return {
      ok: true,
      value: { action: 'create', recordingId: input.recordingId.toLowerCase(), expiresInDays: days, device: device.value },
    };
  }
  if (input.action === 'list') {
    if (typeof input.recordingId !== 'string' || !UUID.test(input.recordingId)) {
      return { ok: false, error: 'recordingId must be a UUID.' };
    }
    return { ok: true, value: { action: 'list', recordingId: input.recordingId.toLowerCase() } };
  }
  if (input.action === 'revoke') {
    if (typeof input.shareId !== 'string' || !UUID.test(input.shareId)) return { ok: false, error: 'shareId must be a UUID.' };
    return { ok: true, value: { action: 'revoke', shareId: input.shareId.toLowerCase() } };
  }
  return { ok: false, error: 'action must be create, list or revoke.' };
}

/** Storage objects are always `<userId>/<recordingId>.<ext>`; refuse anything else. */
export function isOwnedStoragePath(path: string, userId: string): boolean {
  if (!path.startsWith(`${userId}/`)) return false;
  const rest = path.slice(userId.length + 1);
  return rest.length > 0 && !rest.includes('/') && !rest.includes('..');
}
