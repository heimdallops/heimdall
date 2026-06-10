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

  public get effectiveCode(): string {
    const visited = new Set<unknown>();
    let deepestCode = this.code;
    let current: unknown = this.cause;

    while (current instanceof EngineError) {
      if (visited.has(current)) {
        break;
      }

      visited.add(current);
      deepestCode = current.code;
      current = current.cause;
    }

    return deepestCode;
  }

  public override toString(): string {
    const parts: string[] = [this.message];
    const visited = new Set<unknown>();
    let current: unknown = this.cause;

    while (current instanceof Error) {
      if (visited.has(current)) {
        break;
      }

      visited.add(current);
      parts.push(current.message);
      current = current.cause;
    }

    return parts.join(': ');
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

export interface NodeErrorOptions extends EngineCauseOptions {
  readonly nodeName?: string | undefined;
}

/** Thrown when a node fails during execution. Includes the node's id and display name for diagnosis. */
export class NodeError extends EngineError {
  public readonly nodeId: string;
  public readonly nodeName: string | undefined;

  public constructor(message: string, code: string, nodeId: string, options?: NodeErrorOptions) {
    const displayName = options?.nodeName ?? nodeId;
    super(`${message} (node: "${displayName}")`, code, { cause: options?.cause });
    this.name = 'NodeError';
    this.nodeId = nodeId;
    this.nodeName = options?.nodeName;
  }

  public displayName(): string {
    return this.nodeName ?? this.nodeId;
  }
}
