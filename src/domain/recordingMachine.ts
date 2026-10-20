/**
 * Pure state machine for the browser recorder UI.
 *
 * Design rule: `phase === 'recording'` is only ever entered through an explicit event that
 * the recorder emits after it has verified that the MediaRecorder is running AND the
 * microphone track is live and unmuted. Anything that can silently stop capture (track
 * ended, track muted, no data for several seconds, MediaRecorder error) is represented by a
 * dedicated event so the UI can never keep showing "recording" after capture stopped.
 */

export type RecorderPhase = 'idle' | 'requesting' | 'recording' | 'paused' | 'interrupted' | 'stopping' | 'error';

export type InterruptionReason = 'track_ended' | 'track_muted' | 'stalled' | 'recorder_error';

export interface InterruptionRecord {
  reason: InterruptionReason;
  message: string;
  at: number;
}

export interface RecorderError {
  code: string;
  message: string;
}

export interface RecorderMachineState {
  phase: RecorderPhase;
  sessionId: string | null;
  title: string;
  startedAt: number | null;
  /** Time (ms) accumulated by completed capture stretches. */
  accumulatedMs: number;
  /** Timestamp the current capture stretch began, or null when not capturing. */
  activeSince: number | null;
  interruption: InterruptionRecord | null;
  interruptions: InterruptionRecord[];
  error: RecorderError | null;
  lastChunkAt: number | null;
  /** Timestamp the tab became hidden while a session was live, or null. */
  hiddenSince: number | null;
}

export type RecorderEvent =
  | { type: 'START_REQUESTED'; sessionId: string; title: string; now: number }
  | { type: 'STARTED'; now: number }
  | { type: 'START_FAILED'; error: RecorderError }
  | { type: 'PAUSE'; now: number }
  | { type: 'RESUME'; now: number }
  | { type: 'INTERRUPTED'; reason: InterruptionReason; message: string; now: number }
  | { type: 'RECOVERED'; now: number }
  | { type: 'CHUNK'; now: number }
  | { type: 'STOP_REQUESTED'; now: number }
  | { type: 'STOPPED' }
  | { type: 'FAILED'; error: RecorderError; now: number }
  | { type: 'VISIBILITY'; hidden: boolean; now: number }
  | { type: 'RENAME'; title: string }
  | { type: 'RESET' };

export const INITIAL_RECORDER_STATE: RecorderMachineState = {
  phase: 'idle',
  sessionId: null,
  title: '',
  startedAt: null,
  accumulatedMs: 0,
  activeSince: null,
  interruption: null,
  interruptions: [],
  error: null,
  lastChunkAt: null,
  hiddenSince: null,
};

/** Milliseconds of audio capture so far. Never counts paused or interrupted time. */
export function elapsedMs(state: RecorderMachineState, now: number): number {
  if (state.activeSince === null) return state.accumulatedMs;
  return state.accumulatedMs + Math.max(0, now - state.activeSince);
}

/** True for phases where a session exists and its data must be kept safe. */
export function isSessionLive(state: RecorderMachineState): boolean {
  return (
    state.phase === 'requesting' ||
    state.phase === 'recording' ||
    state.phase === 'paused' ||
    state.phase === 'interrupted' ||
    state.phase === 'stopping'
  );
}

/** Settle the active stretch into accumulatedMs. */
function settle(state: RecorderMachineState, now: number): Pick<RecorderMachineState, 'accumulatedMs' | 'activeSince'> {
  return { accumulatedMs: elapsedMs(state, now), activeSince: null };
}

export function recorderReducer(state: RecorderMachineState, event: RecorderEvent): RecorderMachineState {
  switch (event.type) {
    case 'START_REQUESTED':
      if (state.phase !== 'idle' && state.phase !== 'error') return state;
      return {
        ...INITIAL_RECORDER_STATE,
        phase: 'requesting',
        sessionId: event.sessionId,
        title: event.title,
      };

    case 'STARTED':
      if (state.phase !== 'requesting') return state;
      return {
        ...state,
        phase: 'recording',
        startedAt: event.now,
        activeSince: event.now,
        accumulatedMs: 0,
        lastChunkAt: event.now,
      };

    case 'START_FAILED':
      if (state.phase !== 'requesting') return state;
      return { ...INITIAL_RECORDER_STATE, phase: 'error', error: event.error };

    case 'PAUSE':
      if (state.phase !== 'recording') return state;
      return { ...state, ...settle(state, event.now), phase: 'paused' };

    case 'RESUME':
      if (state.phase !== 'paused') return state;
      return { ...state, phase: 'recording', activeSince: event.now, lastChunkAt: event.now };

    case 'INTERRUPTED': {
      // Only a capturing session can be interrupted; a paused one is not capturing anyway.
      if (state.phase !== 'recording') return state;
      const record: InterruptionRecord = { reason: event.reason, message: event.message, at: event.now };
      return {
        ...state,
        ...settle(state, event.now),
        phase: 'interrupted',
        interruption: record,
        interruptions: [...state.interruptions, record],
      };
    }

    case 'RECOVERED':
      if (state.phase !== 'interrupted') return state;
      return { ...state, phase: 'recording', activeSince: event.now, interruption: null, lastChunkAt: event.now };

    case 'CHUNK':
      if (state.phase === 'idle' || state.phase === 'error') return state;
      return { ...state, lastChunkAt: event.now };

    case 'STOP_REQUESTED':
      if (state.phase !== 'recording' && state.phase !== 'paused' && state.phase !== 'interrupted') return state;
      return { ...state, ...settle(state, event.now), phase: 'stopping' };

    case 'STOPPED':
      if (state.phase !== 'stopping') return state;
      return { ...INITIAL_RECORDER_STATE };

    case 'FAILED':
      if (!isSessionLive(state)) return state;
      return { ...state, ...settle(state, event.now), phase: 'error', error: event.error };

    case 'VISIBILITY':
      if (!isSessionLive(state)) return state;
      return { ...state, hiddenSince: event.hidden ? (state.hiddenSince ?? event.now) : null };

    case 'RENAME':
      return { ...state, title: event.title };

    case 'RESET':
      return { ...INITIAL_RECORDER_STATE };

    default:
      return state;
  }
}

/** Has a supposedly-recording session stopped delivering audio? */
export function isStalled(state: RecorderMachineState, now: number, stallMs = 4000): boolean {
  if (state.phase !== 'recording') return false;
  const reference = state.lastChunkAt ?? state.activeSince;
  if (reference === null) return false;
  return now - reference > stallMs;
}
