import type { ActionItem, Notes, Recording, UnfinishedSession } from '../domain/types';

/**
 * Builders for test fixtures. Every field is filled so tests only spell out what they care
 * about, and new fields added to the domain model only need to be added here.
 */
export function makeRecording(idOrOverrides: string | Partial<Recording> = {}, overrides: Partial<Recording> = {}): Recording {
  const base = typeof idOrOverrides === 'string' ? { ...overrides, id: idOrOverrides } : idOrOverrides;
  const id = base.id ?? 'rec-1';
  return {
    id,
    title: `Recording ${id}`,
    createdAt: '2026-01-10T10:00:00.000Z',
    updatedAt: '2026-01-10T10:00:00.000Z',
    durationMs: 60_000,
    sizeBytes: 9,
    mimeType: 'audio/webm',
    quality: 'standard',
    status: 'local',
    failedStage: null,
    errorMessage: null,
    hasLocalAudio: true,
    remotePath: null,
    language: null,
    wasInterrupted: false,
    interruptionNote: null,
    interruptionAcknowledged: false,
    checksumSha256: null,
    audioDeletedAt: null,
    inCloud: false,
    pinned: false,
    collection: null,
    moments: [],
    ...base,
  };
}

export function makeNotes(overrides: Partial<Notes> = {}): Notes {
  return {
    recordingId: 'rec-1',
    summary: 'A summary',
    keyTakeaways: [],
    decisions: [],
    chapters: [],
    topics: [],
    provider: 'anthropic',
    model: 'test-model',
    userEdited: false,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

export function makeActionItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    id: 'a1',
    recordingId: 'rec-1',
    text: 'Do the thing',
    assignee: null,
    dueDate: null,
    done: false,
    sortOrder: 0,
    atMs: null,
    ...overrides,
  };
}

export function makeSession(overrides: Partial<UnfinishedSession> = {}): UnfinishedSession {
  return {
    id: 's1',
    title: 'Session',
    mimeType: 'audio/webm',
    quality: 'standard',
    startedAt: '2026-01-10T10:00:00.000Z',
    elapsedMs: 0,
    heartbeatAt: 0,
    chunkCount: 0,
    wasInterrupted: false,
    moments: [],
    ...overrides,
  };
}
