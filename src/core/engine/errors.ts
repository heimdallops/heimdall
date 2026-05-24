export interface EngineCauseOptions {
  readonly cause?: unknown;
}

/** Base error for all engine failures. The engine never throws CliError — it is CLI-agnostic. */
export class EngineError extends Error {
  public readonly code: string;

  public constructor(message: string, code: string, options?: EngineCauseOptions) {
    super(message, { cause: options?.cause });
    this.name = 'EngineError';
    this.code = code;
  }
}

/** Thrown by Engine.from() when the YAML is malformed or fails schema validation. */
export class EngineValidationError extends EngineError {
  public constructor(message: string, options?: EngineCauseOptions) {
    super(message, 'ENGINE_VALIDATION_ERROR', options);
    this.name = 'EngineValidationError';
  }
}

/** Thrown when a workflow is structurally invalid before execution begins. */
export class EngineConfigError extends EngineError {
  public constructor(message: string, options?: EngineCauseOptions) {
    super(message, 'ENGINE_CONFIG_ERROR', options);
    this.name = 'EngineConfigError';
  }
}
