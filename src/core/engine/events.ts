// Run events: the record of one workflow run, one object per line of events.jsonl. The format is
// documented for outside consumers in schemas/events/event.yaml — keep the two in sync by hand.

export type OutputStream = 'stdout' | 'stderr' | 'agent' | 'tool';

/** Identifies one instance of a node: loop bodies run once per iteration, and a node may retry. */
export interface NodeRef {
  id: string;
  /** The node's display name (name, falling back to id). */
  name: string;
  /** The node type's YAML key: 'bash', 'agent', 'prompt', 'prompt_file', 'loop', 'approval', 'exit', 'break'. */
  type: string;
  /** Node ids and 0-based loop iteration indexes from the root, e.g. ['retry_loop', 1, 'fix']. */
  path: (string | number)[];
  /** 1-based attempt number; 0 when the node was never dispatched (skipped, `if` error). */
  attempt: number;
}

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  exitCode?: number;
  signal?: string;
  stack?: string;
  cause?: SerializedError;
}

interface EventBase<T extends string, D> {
  version: 1;
  /** Monotonic per run, starting at 1, with no gaps. */
  sequence: number;
  /** ISO 8601. */
  timestamp: string;
  runId: string;
  type: T;
  data: D;
}

interface NodeEventBase<T extends string, D> extends EventBase<T, D> {
  node: NodeRef;
}

type RunEvent =
  | EventBase<'run.started', { workflow: string; cwd: string; runDirectory: string }>
  | EventBase<'run.exited', { reason?: string; failure: boolean }>
  | EventBase<'run.completed', { success: boolean; exitReason?: string; error?: SerializedError }>;

type NodeEvent =
  | NodeEventBase<'node.started', Record<string, never>>
  | NodeEventBase<'node.output', { stream: OutputStream; text: string }>
  | NodeEventBase<'node.retrying', { error: SerializedError; delayMs: number }>
  | NodeEventBase<'node.completed', { result: unknown; control?: 'exit' | 'break' }>
  | NodeEventBase<'node.failed', { error: SerializedError }>
  | NodeEventBase<'node.skipped', { reason: 'if' | 'dependency_skipped' | 'halted' }>
  | NodeEventBase<'node.cancelled', Record<string, never>>
  | NodeEventBase<'approval.requested', { message: string; enableFeedback: boolean }>
  | NodeEventBase<'approval.resolved', { approved: boolean; feedback?: string }>;

export type HeimdallEvent = RunEvent | NodeEvent;
export type RunEventType = RunEvent['type'];
export type NodeEventType = NodeEvent['type'];
export type EventData<T extends HeimdallEvent['type']> = Extract<
  HeimdallEvent,
  { type: T }
>['data'];

// JSON.stringify throws on a BigInt, and CEL integers and loop iteration counts are BigInt. Every
// BigInt becomes a decimal string, whatever its size, so a field always has one JSON type.
// Unlike cel.ts's interpolation replacer, which keeps safe-range values as numbers.
export const jsonReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

const MAX_CAUSE_DEPTH = 10;

const stringifyNonError = (value: unknown): string => {
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value, jsonReplacer);
    } catch {
      return '[unserializable object]';
    }
  }

  return String(value);
};

// execa results (and ExecaError) carry a one-line shortMessage; their message embeds the full output.
const shortMessageOf = (value: object): string | undefined => {
  const { shortMessage } = value as { shortMessage?: unknown };

  return typeof shortMessage === 'string' ? shortMessage : undefined;
};

const serializeAt = (value: unknown, depth: number, seen: Set<object>): SerializedError => {
  if (typeof value !== 'object' || value === null) {
    return { name: 'NonError', message: String(value) };
  }

  seen.add(value);
  const shortMessage = shortMessageOf(value);
  if (!(value instanceof Error) && shortMessage === undefined) {
    return { name: 'NonError', message: stringifyNonError(value) };
  }

  const fields = value as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    exitCode?: unknown;
    signal?: unknown;
    stack?: unknown;
    cause?: unknown;
  };
  const result: SerializedError = {
    name: typeof fields.name === 'string' ? fields.name : 'Error',
    message: shortMessage ?? (typeof fields.message === 'string' ? fields.message : ''),
  };
  if (typeof fields.code === 'string') {
    result.code = fields.code;
  }

  if (typeof fields.exitCode === 'number') {
    result.exitCode = fields.exitCode;
  }

  if (typeof fields.signal === 'string') {
    result.signal = fields.signal;
  }

  if (typeof fields.stack === 'string') {
    result.stack = fields.stack;
  }

  // A cyclic or over-deep cause chain is cut off rather than serialized forever.
  const { cause } = fields;
  if (
    cause !== undefined &&
    depth < MAX_CAUSE_DEPTH &&
    !(typeof cause === 'object' && cause !== null && seen.has(cause))
  ) {
    result.cause = serializeAt(cause, depth + 1, seen);
  }

  return result;
};

/** Converts any thrown value into a JSON-safe error record, following `cause`. Never throws. */
export const serializeError = (err: unknown): SerializedError => serializeAt(err, 0, new Set());

/**
 * The message of the innermost Error in the `cause` chain — the real reason behind wrappers like
 * the scheduler's "Node failed". Falls back to `String(err)` for non-Errors.
 */
export const rootErrorMessage = (err: unknown): string => {
  if (!(err instanceof Error)) {
    return String(err);
  }

  const seen = new Set<unknown>([err]);
  let current: Error = err;
  while (current.cause instanceof Error && !seen.has(current.cause)) {
    seen.add(current.cause);
    current = current.cause;
  }

  return shortMessageOf(current) ?? current.message;
};
