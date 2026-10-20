import { create } from 'zustand';
import { backend } from '../../app/backend';
import { localStore } from '../../app/localStore';
import type { Recording } from '../../domain/types';
import { errorMessage } from '../../lib/errors';
import { toast } from '../../state/toastStore';

interface PlaybackState {
  activeId: string | null;
  playing: boolean;
  loading: boolean;
  toggle(recording: Recording): Promise<void>;
  stop(): void;
}

let audio: HTMLAudioElement | null = null;
let objectUrl: string | null = null;

function release() {
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
}

/** One shared audio element so list rows can play quickly and only one plays at a time. */
export const useInlinePlayback = create<PlaybackState>((set, get) => ({
  activeId: null,
  playing: false,
  loading: false,

  async toggle(recording) {
    const state = get();
    if (state.activeId === recording.id && audio) {
      if (audio.paused) await audio.play().catch(() => undefined);
      else audio.pause();
      return;
    }
    release();
    set({ activeId: recording.id, playing: false, loading: true });
    try {
      let url: string | null = null;
      if (recording.hasLocalAudio) {
        const blob = await localStore.getAudio(recording.id);
        if (blob) {
          objectUrl = URL.createObjectURL(blob);
          url = objectUrl;
        }
      }
      if (!url && recording.remotePath && backend) url = await backend.createAudioUrl(recording.remotePath);
      if (!url) throw new Error('The original audio is no longer available.');

      audio ??= new Audio();
      audio.src = url;
      audio.onplay = () => set({ playing: true, loading: false });
      audio.onpause = () => set({ playing: false });
      audio.onended = () => set({ playing: false, activeId: null });
      audio.onerror = () => {
        toast.error('This audio could not be played in your browser.');
        set({ playing: false, loading: false, activeId: null });
      };
      await audio.play();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not play this recording.'));
      release();
      set({ activeId: null, playing: false, loading: false });
    }
  },

  stop() {
    release();
    set({ activeId: null, playing: false, loading: false });
  },
}));
