import { z } from 'zod';
import { DEFAULT_SETTINGS, type AppSettings } from './types';

const isoOrNull = z.string().min(1).nullable();

export const settingsSchema = z.object({
  quality: z.enum(['economy', 'standard', 'high']),
  language: z.string().min(2).max(12),
  summaryLength: z.enum(['brief', 'standard', 'detailed']),
  extractActionItems: z.boolean(),
  extractDecisions: z.boolean(),
  keepScreenAwake: z.boolean(),
  onDeviceModel: z.enum(['tiny', 'base']),
  showRecordingReminder: z.boolean(),
  audioRetentionDays: z.number().int().min(1).max(3650).nullable(),
  uploadConsentAt: isoOrNull,
  recordingReminderAckAt: isoOrNull,
});

/**
 * Parse persisted settings field by field so one corrupt value does not wipe the rest.
 * Unknown keys are dropped; invalid/missing keys fall back to defaults.
 */
export function parseSettings(raw: unknown): AppSettings {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const result: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>) {
    if (!(key in source)) continue;
    const field = settingsSchema.shape[key];
    const parsed = field.safeParse(source[key]);
    if (parsed.success) result[key] = parsed.data;
  }
  return result as unknown as AppSettings;
}

export const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Detect automatically' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
  { value: 'pl', label: 'Polish' },
  { value: 'tr', label: 'Turkish' },
  { value: 'ar', label: 'Arabic' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' },
];

export const RETENTION_OPTIONS: Array<{ value: number | null; label: string }> = [
  { value: null, label: 'Keep until I delete them' },
  { value: 7, label: '7 days after processing' },
  { value: 30, label: '30 days after processing' },
  { value: 90, label: '90 days after processing' },
];

/** Validates a title typed by the user. */
export const titleSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1, 'Please enter a title.').max(120, 'Titles can be up to 120 characters.'));
