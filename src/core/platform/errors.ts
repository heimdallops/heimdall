export class PlatformError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PlatformError';
    this.code = code;
  }
}

export class PlatformCancellationError extends PlatformError {
  constructor(options?: { cause?: unknown }) {
    super('PLATFORM_CANCELLED', 'Operation was cancelled', options);
    this.name = 'PlatformCancellationError';
  }
}
