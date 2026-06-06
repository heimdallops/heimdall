import type { EngineEmitter } from './emitter.ts';
import { EngineError } from './errors.ts';
import type {
  BaseNode,
  ExecutionContext,
  NodeResult,
  NodeRunResult,
  PlatformAdapter,
} from './nodes/base.ts';

export type NodeStatus = 'pending' | 'in_flight' | 'skipped' | 'completed' | 'failed' | 'cancelled';

interface NodeStateEntry {
  node: BaseNode;
  status: NodeStatus;
  sessionId?: string | undefined;
}

export interface SchedulerOptions {
  adapter: PlatformAdapter;
  emitter: EngineEmitter;
  sharedContextMap: Map<string, string>;
}

export interface SchedulerResult {
  outcome: 'completed' | 'exited' | 'broke';
  success: boolean;
  exitReason?: string | undefined;
}

const RETRY_DEFAULTS = {
  max_attempts: 0,
  initial_delay_ms: 1000,
  max_delay_ms: 30000,
} as const;

// Resolves after ms, or immediately if the signal fires — avoids blocking shutdown during backoff.
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();

      return;
    }

    // onAbort is declared after timer so the const binding is visible in the closure —
    // both callbacks only fire asynchronously, so timer is always assigned before either runs.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });

const computeRetryDelay = (attempt: number, initialDelayMs: number, maxDelayMs: number): number => {
  const exponential = initialDelayMs * Math.pow(2, attempt - 1);
  const bounded = Math.min(maxDelayMs, exponential);

  // half-to-full jitter: result spans [0.5×bounded, bounded], never exceeding max_delay_ms
  return bounded * (0.5 + Math.random() * 0.5);
};

const runWithTimeout = (
  runPromise: Promise<NodeRunResult>,
  timeoutMs: number | undefined,
  nodeId: string,
  attemptController: AbortController
): Promise<NodeRunResult> => {
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return runPromise;
  }

  const timeout = sleep(timeoutMs).then((): never => {
    // Abort only this attempt so the underlying node can stop its work.
    attemptController.abort();
    throw new Error(`Node "${nodeId}" timed out after ${timeoutMs}ms`);
  });

  return Promise.race([runPromise, timeout]);
};

const runWithRetry = async (
  node: BaseNode,
  schedulerSignal: AbortSignal,
  buildOptions: (signal: AbortSignal) => Parameters<BaseNode['run']>[0]
): Promise<NodeRunResult> => {
  const maxAttempts = node.retries?.max_attempts ?? RETRY_DEFAULTS.max_attempts;
  const initialDelayMs = node.retries?.initial_delay_ms ?? RETRY_DEFAULTS.initial_delay_ms;
  const maxDelayMs = node.retries?.max_delay_ms ?? RETRY_DEFAULTS.max_delay_ms;

  let lastError: unknown;

  // attempt 0 is the initial try; attempts 1..maxAttempts are retries
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    if (attempt > 0) {
      if (schedulerSignal.aborted) {
        break;
      }

      const waitMs = computeRetryDelay(attempt, initialDelayMs, maxDelayMs);
      await sleep(waitMs, schedulerSignal);

      // Re-check after the (possibly early-woken) sleep.
      if (schedulerSignal.aborted) {
        break;
      }
    }

    // Compose the per-attempt timeout signal with the scheduler's cancellation signal so BOTH abort the run.
    const attemptController = new AbortController();
    const attemptSignal = AbortSignal.any([schedulerSignal, attemptController.signal]);

    try {
      const result = await runWithTimeout(
        node.run(buildOptions(attemptSignal)),
        node.timeout,
        node.id,
        attemptController
      );

      if (result.status !== 'failed') {
        return result;
      }

      lastError = result.error;
    } catch (err) {
      lastError = err;
    }
  }

  return { status: 'failed', error: lastError };
};

export const runScheduler = async (
  nodes: BaseNode[],
  ctx: ExecutionContext,
  options: SchedulerOptions
): Promise<SchedulerResult> => {
  const { adapter, emitter, sharedContextMap } = options;

  // Mutable needs map — shared by reference across all concurrent dispatches so nodes always see the latest completed results
  const needs = new Map<string, NodeResult>(ctx.needs);

  const state = new Map<string, NodeStateEntry>(
    nodes.map((node) => [node.id, { node, status: 'pending' }])
  );

  let hasFailure = false;
  let exitResult: { reason?: string | undefined; failure: boolean } | undefined;
  let broke = false;
  let pendingCount = nodes.length;

  const inFlightSet = new Set<Promise<void>>();
  const controller = new AbortController();

  const buildCtx = (): ExecutionContext => ({ ...ctx, needs });

  // Marks all in-flight nodes as cancelled, emits node_cancelled for each, then signals the abort controller
  const cancelInFlight = (): void => {
    for (const [nodeId, e] of state.entries()) {
      if (e.status === 'in_flight') {
        e.status = 'cancelled';
        emitter.emit('node_cancelled', { nodeId, nodeName: e.node.displayName() });
      }
    }

    controller.abort();
  };

  const dispatchNode = (entry: NodeStateEntry): void => {
    const { node } = entry;

    entry.status = 'in_flight';
    pendingCount--;
    emitter.emit('node_started', { nodeId: node.id, nodeName: node.displayName() });

    const predecessorId = sharedContextMap.get(node.id);
    const predecessorSessionId = predecessorId ? state.get(predecessorId)?.sessionId : undefined;

    const buildOptions = (signal: AbortSignal): Parameters<BaseNode['run']>[0] => ({
      ctx: buildCtx(),
      adapter,
      emitter,
      signal,
      predecessorSessionId,
    });

    const promise = runWithRetry(node, controller.signal, buildOptions).then((result) => {
      // Once a control-flow signal (exit/break) is recorded or this node was cancelled, discard the settlement
      if (exitResult || broke || entry.status === 'cancelled') {
        return;
      }

      switch (result.status) {
        case 'exited':
          entry.status = 'completed';
          exitResult = { ...result };

          cancelInFlight();

          emitter.emit('workflow_exited', { ...result });

          return;

        case 'break':
          // break is a control-flow signal surfaced to the caller (e.g. LoopNode); top-level break never reaches here because validation rejects it
          entry.status = 'completed';
          broke = true;

          cancelInFlight();

          return;

        case 'completed':
          entry.status = 'completed';
          entry.sessionId = result.sessionId;

          needs.set(node.id, result.result);
          emitter.emit('node_completed', {
            nodeId: node.id,
            nodeName: node.displayName(),
            result: result.result,
          });

          return;

        case 'failed':
          entry.status = 'failed';
          hasFailure = true;
          emitter.emit('node_failed', {
            nodeId: node.id,
            nodeName: node.displayName(),
            error: result.error instanceof Error ? result.error : new Error(String(result.error)),
          });
      }
    });

    const tracked = promise.finally(() => inFlightSet.delete(tracked));
    inFlightSet.add(tracked);
  };

  const dispatchEligible = (): void => {
    if (exitResult || broke) {
      return;
    }

    if (hasFailure) {
      // halt on first failure — do not start new work while the run is in a failed state
      return;
    }

    for (const entry of state.values()) {
      if (entry.status !== 'pending') {
        continue;
      }

      const deps = entry.node.getDependencies();
      const allSettled = deps.every((depId) => {
        const depStatus = state.get(depId)?.status;

        return depStatus === 'completed' || depStatus === 'skipped';
      });

      if (!allSettled) {
        continue;
      }

      const anySkipped = deps.some((depId) => state.get(depId)?.status === 'skipped');
      if (anySkipped) {
        entry.status = 'skipped';
        pendingCount--;
        emitter.emit('node_skipped', { nodeId: entry.node.id, nodeName: entry.node.displayName() });
        // A newly skipped node may unblock further nodes — recurse
        dispatchEligible();

        continue;
      }

      let shouldRun: boolean;
      try {
        shouldRun = entry.node.evaluateIf(buildCtx());
      } catch {
        // evaluateIf throws NodeError for type mismatches; treat as failure
        entry.status = 'failed';
        pendingCount--;
        hasFailure = true;
        emitter.emit('node_failed', {
          nodeId: entry.node.id,
          nodeName: entry.node.displayName(),
          error: new Error(`Failed to evaluate if expression for node "${entry.node.id}"`),
        });

        return;
      }

      if (!shouldRun) {
        entry.status = 'skipped';
        pendingCount--;
        emitter.emit('node_skipped', { nodeId: entry.node.id, nodeName: entry.node.displayName() });
        dispatchEligible();

        continue;
      }

      dispatchNode(entry);
    }
  };

  dispatchEligible();

  while (pendingCount > 0 || inFlightSet.size > 0) {
    if (inFlightSet.size === 0) {
      // Expected when exit/break/failure halted dispatch, leaving pending nodes undispatched; otherwise the graph is deadlocked.
      if (exitResult || broke || hasFailure) {
        break;
      }

      throw new EngineError(
        `Scheduler deadlocked: ${pendingCount} node(s) pending with nothing in-flight; the node list was not validated (cycle or unknown dependency reference)`,
        'ENGINE_SCHEDULER_DEADLOCK'
      );
    }

    await Promise.race(inFlightSet);

    dispatchEligible();
  }

  if (exitResult) {
    return {
      outcome: 'exited',
      success: !exitResult.failure && !hasFailure,
      exitReason: exitResult.reason,
    };
  }

  if (broke) {
    return { outcome: 'broke', success: !hasFailure };
  }

  return { outcome: 'completed', success: !hasFailure };
};
