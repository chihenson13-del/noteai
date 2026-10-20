import { useCallback } from 'react';
import { onDevice } from '../../app/container';
import { isAbort } from '../../services/onDeviceProcessing';
import type { OnDeviceProgressUpdate } from '../../services/onDeviceProcessing';
import { errorMessage } from '../../lib/errors';
import { useOnDeviceStore } from '../../state/onDeviceStore';
import { toast } from '../../state/toastStore';

export interface OnDeviceControls {
  /** This browser can run the on-device transcriber. */
  supported: boolean;
  start(recordingId: string, options?: { summarizeOnly?: boolean }): void;
  cancel(recordingId: string): void;
  isRunning(recordingId: string): boolean;
}

/**
 * Entry point for transcribing / summarizing on this device. Unlike the cloud path it needs no
 * account and no upload consent, because nothing leaves the device.
 */
export function useOnDevice(): OnDeviceControls {
  const start = useCallback((recordingId: string, options?: { summarizeOnly?: boolean }) => {
    if (onDevice.isRunning(recordingId)) return;
    onDevice
      .run(recordingId, options)
      .then(() => toast.success(options?.summarizeOnly ? 'Notes rebuilt from the transcript.' : 'Transcript and notes are ready.'))
      .catch((error: unknown) => {
        if (isAbort(error)) {
          toast.info('Transcription cancelled. Your recording is unchanged.');
          return;
        }
        toast.error(errorMessage(error));
      });
  }, []);

  const cancel = useCallback((recordingId: string) => onDevice.cancel(recordingId), []);
  const isRunning = useCallback((recordingId: string) => onDevice.isRunning(recordingId), []);

  return { supported: onDevice.isSupported(), start, cancel, isRunning };
}

export function useOnDeviceProgress(recordingId: string | undefined): OnDeviceProgressUpdate | null {
  return useOnDeviceStore((s) => (recordingId ? (s.jobs[recordingId] ?? null) : null));
}
