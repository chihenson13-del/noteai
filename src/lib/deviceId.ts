import { newId } from './id';

const KEY = 'noteai.deviceId';
const VALID = /^[A-Za-z0-9-]{16,64}$/;

let memoryId: string | null = null;

/**
 * A random id that identifies THIS browser profile on THIS device. It is what "one device per
 * code" is bound to. Honest limits: clearing site data, using a private window, or another
 * browser on the same computer looks like a different device.
 */
export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing && VALID.test(existing)) return existing;
    const id = newId();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    // Storage blocked (private mode): keep one id for the life of the page.
    memoryId ??= newId();
    return memoryId;
  }
}

/** "Chrome on Windows": a coarse label so the code owner can recognise the device later. */
export function describeDevice(userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : 'Browser';
  const os = /Windows/.test(userAgent)
    ? 'Windows'
    : /Android/.test(userAgent)
      ? 'Android'
      : /iPhone|iPad|iPod/.test(userAgent)
        ? 'iOS'
        : /Mac OS X/.test(userAgent)
          ? 'macOS'
          : /CrOS/.test(userAgent)
            ? 'ChromeOS'
            : /Linux/.test(userAgent)
              ? 'Linux'
              : 'unknown OS';
  return `${browser} on ${os}`;
}
