export interface CliErrorOptions {
  readonly code: string;
  readonly exitCode: number;
  readonly cause?: unknown;
}

export class CliError extends Error {
  public readonly code: string;
  public readonly exitCode: number;

  public constructor(message: string, options: CliErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'CliError';
    this.code = options.code;
    this.exitCode = options.exitCode;
  }
}

export const EXIT_CODE = {
  SUCCESS: 0,
  USAGE: 2,
  CONFIG: 3,
  AUTH: 4,
  UNKNOWN: 1,
} as const;

export const ERROR_CODE = {
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  WORKFLOW_INVALID: 'WORKFLOW_INVALID',
  WORKFLOW_CONFIG_ERROR: 'WORKFLOW_CONFIG_ERROR',
  WORKFLOW_FAILED: 'WORKFLOW_FAILED',
  MISSING_INPUTS: 'MISSING_INPUTS',
  UNKNOWN_INPUT: 'UNKNOWN_INPUT',
} as const;
