import { STAGE_LABEL } from './status';
import type { Recording } from './types';

export interface AttentionItem {
  recording: Recording;
  kind: 'failed' | 'interrupted';
  message: string;
}

/**
 * Recordings that need the user's eyes: failed processing (audio is still safe) and captures
 * that were interrupted and not yet acknowledged. Failed items come first, newest first.
 */
export function attentionItems(recordings: Recording[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const recording of recordings) {
    if (recording.status === 'failed') {
      const stage = recording.failedStage ? STAGE_LABEL[recording.failedStage] : 'Processing';
      items.push({
        recording,
        kind: 'failed',
        message: recording.errorMessage ? `${stage} failed: ${recording.errorMessage}` : `${stage} failed`,
      });
    } else if (recording.wasInterrupted && !recording.interruptionAcknowledged) {
      items.push({
        recording,
        kind: 'interrupted',
        message: recording.interruptionNote ?? 'Capture was interrupted, so parts may be missing.',
      });
    }
  }
  return items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'failed' ? -1 : 1;
    return Date.parse(b.recording.createdAt) - Date.parse(a.recording.createdAt);
  });
}
