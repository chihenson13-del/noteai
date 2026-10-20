import { create } from 'zustand';
import type { OnDeviceProgressUpdate } from '../services/onDeviceProcessing';

interface OnDeviceState {
  /** Live progress of running on-device jobs, by recording id. */
  jobs: Record<string, OnDeviceProgressUpdate>;
  set(recordingId: string, progress: OnDeviceProgressUpdate | null): void;
}

export const useOnDeviceStore = create<OnDeviceState>((set) => ({
  jobs: {},
  set: (recordingId, progress) =>
    set((state) => {
      const jobs = { ...state.jobs };
      if (progress) jobs[recordingId] = progress;
      else delete jobs[recordingId];
      return { jobs };
    }),
}));
