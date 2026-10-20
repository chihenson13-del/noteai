import { pickRecorderMimeType } from '../domain/audioMime';

export interface RecordingSupport {
  supported: boolean;
  /** Human readable reasons why recording is not possible (empty when supported). */
  problems: string[];
  secureContext: boolean;
  hasGetUserMedia: boolean;
  hasMediaRecorder: boolean;
  mimeType: string | null;
  hasWakeLock: boolean;
  isMobile: boolean;
}

export function detectRecordingSupport(env: {
  isSecureContext?: boolean;
  mediaDevices?: unknown;
  MediaRecorder?: { isTypeSupported(mime: string): boolean } | undefined;
  navigator?: { userAgent?: string; wakeLock?: unknown; maxTouchPoints?: number };
} = {
  isSecureContext: typeof window !== 'undefined' ? window.isSecureContext : false,
  mediaDevices: typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined,
  MediaRecorder: typeof MediaRecorder !== 'undefined' ? MediaRecorder : undefined,
  navigator: typeof navigator !== 'undefined' ? navigator : undefined,
}): RecordingSupport {
  const secureContext = env.isSecureContext === true;
  const md = env.mediaDevices as { getUserMedia?: unknown } | undefined;
  const hasGetUserMedia = !!md && typeof md.getUserMedia === 'function';
  const hasMediaRecorder = !!env.MediaRecorder && typeof env.MediaRecorder.isTypeSupported === 'function';
  const mimeType = hasMediaRecorder ? pickRecorderMimeType((m) => env.MediaRecorder!.isTypeSupported(m)) : null;
  const ua = env.navigator?.userAgent ?? '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (env.navigator?.maxTouchPoints ?? 0) > 1 && /Macintosh/.test(ua);

  const problems: string[] = [];
  if (!secureContext) problems.push('Recording needs a secure (HTTPS) connection. Open this site over https:// or on localhost.');
  if (!hasGetUserMedia) problems.push('This browser does not provide microphone access (getUserMedia).');
  if (!hasMediaRecorder) problems.push('This browser does not support the MediaRecorder API. Update your browser or try Chrome, Edge, Firefox or Safari.');
  else if (!mimeType) problems.push('This browser has no supported audio recording format.');

  return {
    supported: problems.length === 0,
    problems,
    secureContext,
    hasGetUserMedia,
    hasMediaRecorder,
    mimeType,
    hasWakeLock: !!env.navigator && 'wakeLock' in env.navigator,
    isMobile,
  };
}
