import { create } from 'zustand';
import type { WakeLockState } from '../domain/captureHealth';

interface WakeLockStoreState {
  state: WakeLockState;
  set(state: WakeLockState): void;
}

/** Shared so the capture-health card can show what the app shell's wake lock is actually doing. */
export const useWakeLockStore = create<WakeLockStoreState>((set) => ({
  state: 'off',
  set: (state) => set({ state }),
}));
