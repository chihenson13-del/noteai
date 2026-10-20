import { create } from 'zustand';
import { DEFAULT_SETTINGS, type AppSettings } from '../domain/types';
import { localStore } from '../app/localStore';

interface SettingsState {
  settings: AppSettings;
  loaded: boolean;
  load(): Promise<void>;
  update(patch: Partial<AppSettings>): Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS },
  loaded: false,
  async load() {
    try {
      set({ settings: await localStore.getSettings(), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  async update(patch) {
    const next = { ...get().settings, ...patch };
    set({ settings: next });
    await localStore.saveSettings(next);
  },
}));
