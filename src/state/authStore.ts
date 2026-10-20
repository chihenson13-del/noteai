import { create } from 'zustand';
import { backend } from '../app/backend';
import type { CloudUser, DeviceProfileInput } from '../data/backend';
import { describeDevice, getDeviceId } from '../lib/deviceId';
import { errorMessage } from '../lib/errors';

export type AuthStatus = 'disabled' | 'loading' | 'signedOut' | 'signedIn';

interface AuthState {
  status: AuthStatus;
  user: CloudUser | null;
  /** True after the user followed a password-reset email link and must choose a new password. */
  recovering: boolean;
  /** Signed in with an admin code (confirmed by the server). */
  isAdmin: boolean;
  init(): void;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<{ needsEmailConfirmation: boolean }>;
  signInWithCode(code: string, profile?: DeviceProfileInput): Promise<void>;
  signOut(): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
  updatePassword(password: string): Promise<void>;
}

let started = false;

/** Asks the server whether this user holds an admin code. Never throws: failing means "not an admin". */
async function checkAdmin(user: CloudUser | null): Promise<boolean> {
  if (!backend?.adminWhoAmI || !user?.viaCode) return false;
  try {
    return await backend.adminWhoAmI();
  } catch {
    return false;
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  status: backend ? 'loading' : 'disabled',
  user: null,
  recovering: false,
  isAdmin: false,

  init() {
    if (started || !backend) return;
    started = true;
    backend
      .getUser()
      .then((user) => {
        set({ user, status: user ? 'signedIn' : 'signedOut' });
        void checkAdmin(user).then((isAdmin) => set({ isAdmin }));
      })
      .catch(() => set({ user: null, status: 'signedOut' }));
    backend.onAuthChange((user, event) => {
      set((state) => ({
        user,
        status: user ? 'signedIn' : 'signedOut',
        recovering: event === 'PASSWORD_RECOVERY' ? true : user ? state.recovering : false,
        isAdmin: user ? state.isAdmin : false,
      }));
      // Not awaited inside the auth callback: the admin check itself calls the auth client.
      if (user) setTimeout(() => void checkAdmin(user).then((isAdmin) => set({ isAdmin })), 0);
    });
  },

  async signIn(email, password) {
    if (!backend) throw new Error('No backend is configured.');
    await backend.signIn(email, password);
  },

  async signInWithCode(code, profile) {
    if (!backend) throw new Error('No backend is configured.');
    await backend.signInWithCode(code, { id: getDeviceId(), label: describeDevice() }, profile);
  },

  async signUp(email, password) {
    if (!backend) throw new Error('No backend is configured.');
    return backend.signUp(email, password);
  },

  async signOut() {
    if (!backend) return;
    try {
      await backend.signOut();
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  },

  async sendPasswordReset(email) {
    if (!backend) throw new Error('No backend is configured.');
    await backend.sendPasswordReset(email);
  },

  async updatePassword(password) {
    if (!backend) throw new Error('No backend is configured.');
    await backend.updatePassword(password);
    set({ recovering: false });
  },
}));
