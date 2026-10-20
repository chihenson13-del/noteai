import type { RecordingQuality } from './types';

/** Preference order. Safari <18.4 only supports audio/mp4; Chromium/Firefox prefer webm/ogg + Opus. */
export const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

export function pickRecorderMimeType(isTypeSupported: (mime: string) => boolean): string | null {
  for (const candidate of MIME_CANDIDATES) {
    try {
      if (isTypeSupported(candidate)) return candidate;
    } catch {
      // some engines throw for unknown strings; treat as unsupported
    }
  }
  return null;
}

/** "audio/webm;codecs=opus" -> "audio/webm" */
export function baseMimeType(mime: string): string {
  return (mime.split(';')[0] ?? mime).trim().toLowerCase();
}

export function extensionForMime(mime: string): string {
  const base = baseMimeType(mime);
  if (base.includes('webm')) return 'webm';
  if (base.includes('mp4') || base.includes('m4a') || base.includes('aac')) return 'm4a';
  if (base.includes('ogg')) return 'ogg';
  if (base.includes('wav')) return 'wav';
  if (base.includes('mpeg') || base.includes('mp3')) return 'mp3';
  return 'bin';
}

/** Target Opus/AAC bitrate. 25 MB (provider upload limit) ≈ 100 min at 32 kbps. */
export const QUALITY_BITRATE: Record<RecordingQuality, number> = {
  economy: 24_000,
  standard: 32_000,
  high: 64_000,
};

export const QUALITY_LABEL: Record<RecordingQuality, { name: string; description: string }> = {
  economy: { name: 'Economy', description: '24 kbps · smallest files, fine for clear speech' },
  standard: { name: 'Standard', description: '32 kbps · recommended for meetings and classes' },
  high: { name: 'High', description: '64 kbps · best fidelity, ~2× the file size' },
};

/** Rough minutes of audio that fit in the transcription provider's upload limit. */
export function minutesWithinLimit(quality: RecordingQuality, limitBytes: number): number {
  const bytesPerMinute = (QUALITY_BITRATE[quality] / 8) * 60;
  return Math.floor(limitBytes / bytesPerMinute);
}

/** Matches the provider limit enforced by the server function. */
export const MAX_PROCESSABLE_BYTES = 25 * 1024 * 1024;
