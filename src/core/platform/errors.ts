export class PlatformError extends Error {
  readonly code: string;

  constructor(message: string, code = 'PLATFORM_ERROR', cause?: unknown) {
    super(message, { cause });
    this.name = 'PlatformError';
    this.code = code;
  }
}

export class PlatformCancellationError extends PlatformError {
  override readonly code = 'PLATFORM_CANCELLED';

  constructor(message?: string) {
    super(message ?? 'Operation was cancelled');
    this.name = 'PlatformCancellationError';
  }
}

export class PlatformAgentNotFoundError extends PlatformError {
  override readonly code = 'PLATFORM_AGENT_NOT_FOUND';
  readonly agentName: string;

  constructor(agentName: string) {
    super(`Agent not found: ${agentName}`);
    this.name = 'PlatformAgentNotFoundError';
    this.agentName = agentName;
  }
}
