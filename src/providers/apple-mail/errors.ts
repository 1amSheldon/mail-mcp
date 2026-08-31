export type AppleMailErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'PERMISSION_DENIED'
  | 'TIMEOUT'
  | 'OUTPUT_LIMIT'
  | 'EXECUTION_FAILED'
  | 'INVALID_ARGUMENT'
  | 'INVALID_RESPONSE';

export class AppleMailError extends Error {
  constructor(
    public readonly code: AppleMailErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AppleMailError';
  }
}

export function appleMailExecutionError(stderr: string, cause?: unknown): AppleMailError {
  const normalized = stderr.toLowerCase();
  if (
    normalized.includes('not authorized')
    || normalized.includes('not permitted')
    || normalized.includes('(-1743)')
    || normalized.includes('automation permission')
  ) {
    return new AppleMailError(
      'PERMISSION_DENIED',
      'macOS denied access to Mail. Grant Automation permission to the process running mail-mcp.',
      { cause },
    );
  }
  return new AppleMailError(
    'EXECUTION_FAILED',
    stderr.trim() || 'Apple Mail automation failed.',
    { cause },
  );
}
