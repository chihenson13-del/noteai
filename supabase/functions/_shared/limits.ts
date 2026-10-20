/** Provider upload limit for audio transcription requests (OpenAI: 25 MB). */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** A job that has been "running" longer than this is considered dead and may be replaced. */
export const STALE_JOB_MS = 15 * 60 * 1000;

/** Hard cap on transcript characters sent to the summarization model (~75k tokens). */
export const MAX_TRANSCRIPT_CHARS = 300_000;

export const MAX_TITLE_CHARS = 200;
export const MAX_LIST_ITEMS = 40;
export const MAX_ITEM_CHARS = 600;
export const MAX_SUMMARY_CHARS = 6000;

export const MAX_CHAPTERS = 12;
export const MAX_CHAPTER_POINTS = 8;
/** An evidence timestamp may be this far from a real transcript segment before it is discarded. */
export const EVIDENCE_TOLERANCE_MS = 15_000;

/** "Ask your recordings": how much of the library is searched and how much reaches the model. */
export const ASK_MAX_RECORDINGS = 40;
export const ASK_MAX_SOURCES = 10;
export const ASK_SOURCE_CHARS = 420;
export const ASK_MAX_QUESTION_CHARS = 500;

export const SHARE_DAYS_ALLOWED = [1, 7, 30] as const;
