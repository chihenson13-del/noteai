import { backend } from './backend';
import { localStore } from './localStore';
import { BrowserRecorder, type RecordedAudio } from '../recording/recorder';
import type { Recording } from '../domain/types';
import { saveRecordedAudio } from '../services/recordingService';
import { ProcessingPipeline } from '../services/pipeline';
import { OnDeviceProcessing } from '../services/onDeviceProcessing';
import { WhisperWorkerEngine } from '../ondevice/transcriber';
import { useOnDeviceStore } from '../state/onDeviceStore';
import { useAuthStore } from '../state/authStore';
import { useLibraryStore } from '../state/libraryStore';
import { useSettingsStore } from '../state/settingsStore';

/**
 * Application singletons. They live outside React so a recording keeps running (and is saved)
 * when the user navigates between screens.
 */
export { backend, localStore };

export const pipeline: ProcessingPipeline | null = backend
  ? new ProcessingPipeline({
      store: localStore,
      backend,
      getUser: () => useAuthStore.getState().user,
      getSettings: () => useSettingsStore.getState().settings,
      onRecordingChanged: (recording) => useLibraryStore.getState().applyRecording(recording),
    })
  : null;

/** Transcription and notes that run entirely on this device. Works with or without a backend. */
export const onDevice = new OnDeviceProcessing({
  store: localStore,
  engine: new WhisperWorkerEngine(),
  getSettings: () => useSettingsStore.getState().settings,
  onRecordingChanged: (recording) => useLibraryStore.getState().applyRecording(recording),
  onProgress: (id, progress) => useOnDeviceStore.getState().set(id, progress),
  onTranscriptStored: () => void useLibraryStore.getState().refreshTranscriptIndex(),
});

export const recorder: BrowserRecorder | null =
  typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined'
    ? new BrowserRecorder({
        mediaDevices: {
          getUserMedia: (constraints) => {
            if (!navigator.mediaDevices?.getUserMedia) {
              return Promise.reject(Object.assign(new Error('Microphone API unavailable'), { name: 'TypeError' }));
            }
            return navigator.mediaDevices.getUserMedia(constraints);
          },
        },
        MediaRecorderCtor: MediaRecorder,
        store: localStore,
      })
    : null;

// Every finished session (user stop OR salvage after a failure) goes through one save path.
const savedSessions = new Map<string, Promise<Recording>>();

recorder?.onFinished((audio: RecordedAudio) => {
  const saving = saveRecordedAudio(localStore, audio).then((recording) => {
    useLibraryStore.getState().applyRecording(recording);
    return recording;
  });
  savedSessions.set(audio.sessionId, saving);
  saving.catch(() => undefined);
});

/** Resolves once the finished session is safely stored in the library. */
export function whenSaved(sessionId: string): Promise<Recording> {
  return savedSessions.get(sessionId) ?? Promise.reject(new Error('Recording was not saved.'));
}
