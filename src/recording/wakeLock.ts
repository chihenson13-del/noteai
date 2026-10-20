/**
 * Keeps the screen on while recording (Screen Wake Lock API). This is a best-effort aid, NOT a
 * guarantee that recording survives a locked screen: the browser releases the lock whenever
 * the page is hidden, and mobile browsers may suspend the page and microphone anyway.
 */
export class ScreenWakeLock {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;
  private readonly onVisibility = () => {
    if (this.wanted && document.visibilityState === 'visible') void this.request();
  };

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  get active(): boolean {
    return this.sentinel !== null && !this.sentinel.released;
  }

  async acquire(): Promise<boolean> {
    if (!ScreenWakeLock.isSupported()) return false;
    this.wanted = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    return this.request();
  }

  async release(): Promise<void> {
    this.wanted = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    const sentinel = this.sentinel;
    this.sentinel = null;
    try {
      await sentinel?.release();
    } catch {
      /* already released */
    }
  }

  private async request(): Promise<boolean> {
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      return true;
    } catch {
      // Denied (low battery / power saver) or page not visible.
      this.sentinel = null;
      return false;
    }
  }
}
