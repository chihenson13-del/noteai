export type AppErrorCode =
  | 'MIC_DENIED'
  | 'MIC_NOT_FOUND'
  | 'MIC_BUSY'
  | 'UNSUPPORTED_BROWSER'
  | 'INSECURE_CONTEXT'
  | 'STORAGE_FAILED'
  | 'AUDIO_MISSING'
  | 'UPLOAD_FAILED'
  | 'PROCESSING_FAILED'
  | 'NETWORK'
  | 'AUTH_REQUIRED'
  | 'BACKEND_NOT_CONFIGURED'
  | 'NOT_CONSENTED'
  | 'FILE_TOO_LARGE'
  | 'ALREADY_RUNNING'
  | 'PROFILE_REQUIRED'
  | 'UNKNOWN';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly retryable: boolean;

  constructor(code: AppErrorCode, message: string, options: { cause?: unknown; retryable?: boolean } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Translate whatever getUserMedia / MediaRecorder threw into an actionable AppError. */
export function micErrorFrom(error: unknown): AppError {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return new AppError(
        'MIC_DENIED',
        'Microphone access is blocked. Allow the microphone for this site in your browser’s address-bar or site settings, then try again.',
        { cause: error },
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new AppError('MIC_NOT_FOUND', 'No microphone was found. Connect or enable a microphone and try again.', { cause: error });
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new AppError(
        'MIC_BUSY',
        'The microphone could not be started. Another app or tab may be using it, or the system is blocking access.',
        { cause: error, retryable: true },
      );
    case 'TypeError':
      return new AppError('UNSUPPORTED_BROWSER', 'This browser cannot record audio. Try a current version of Chrome, Edge, Firefox or Safari.', {
        cause: error,
      });
    default:
      return new AppError('UNKNOWN', error instanceof Error ? error.message : 'Recording could not be started.', { cause: error, retryable: true });
  }
}

export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

export function isNetworkError(error: unknown): boolean {
  if (error instanceof AppError) return error.code === 'NETWORK';
  if (error instanceof TypeError) return /fetch|network|load failed/i.test(error.message);
  return false;
}
