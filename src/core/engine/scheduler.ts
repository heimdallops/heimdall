import type { EngineEmitter } from './emitter.ts';
import { EngineError, NodeError } from './errors.ts';
import type {
  BaseNode,
  ExecutionContext,
  NodeResult,
  NodeRunResult,
  PlatformRuntime,
} from './nodes/base.ts';

export type NodeStatus = 'pending' | 'in_flight' | 'skipped' | 'completed' | 'failed' | 'cancelled';

interface NodeStateEntry {
  node: BaseNode;
  status: NodeStatus;
  sessionId?: string | undefined;
}

export interface SchedulerOptions {
  platform?: PlatformRuntime | undefined;
  emitter: EngineEmitter;
  sharedContextMap: Map<string, string>;
  // External cancellation signal (e.g. a LoopNode's attempt signal). When it fires, the scheduler
  // stops dispatching, drains in-flight nodes through the grace period, and aborts node runs.
  signal?: AbortSignal | undefined;
}

export interface SchedulerResult {
  outcome: 'completed' | 'exited' | 'broke';
  success: boolean;
  exitReason?: string | undefined;
  // Accumulated results of completed nodes, keyed by node id.
  nodeResults: ReadonlyMap<string, NodeResult>;
}

const RETRY_DEFAULTS = {
  max_attempts: 0,
  initial_delay_ms: 1000,
  max_delay_ms: 30000,
} as const;

// Bounds the wait for in-flight nodes to honor an abort after exit/break, so a node that ignores its signal can't hang the scheduler forever.
const CANCELLATION_GRACE_MS = 5 * 60 * 1000;

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
  const exp = initialDelayMs * Math.pow(2, attempt - 1);
  const jittered = exp * (0.5 + Math.random()); // symmetric ±50% jitter keeps delays spread around the target rather than always compressing downward

  return Math.min(maxDelayMs, jittered);
};

const runWithTimeout = (
  runPromise: Promise<NodeRunResult>,
  timeoutMs: number | undefined,
  node: BaseNode,
  attemptController: AbortController
): Promise<NodeRunResult> => {
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return runPromise;
  }

  // timer is assigned synchronously inside the Promise executor, before .finally() ever runs.
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Abort only this attempt so the underlying node can stop its work.
      attemptController.abort();
      reject(
        new NodeError(`Node timed out after ${timeoutMs}ms`, 'ENGINE_NODE_TIMEOUT', node.id, {
          nodeName: node.name,
        })
      );
    }, timeoutMs);
  });

  return Promise.race([runPromise, timeout]).finally(() => {
    clearTimeout(timer);
  });
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
        node,
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
  const { platform, emitter, sharedContextMap } = options;
  const externalSignal = options.signal;

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

  // Node runs abort when EITHER the scheduler's internal control-flow signal (exit/break) or the
  // external cancellation signal fires.
  const nodeRunSignal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;

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
      platform,
      emitter,
      signal,
      predecessorSessionId,
    });

    const promise = runWithRetry(node, nodeRunSignal, buildOptions).then((result) => {
      // Once a control-flow signal (exit/break) is recorded or this node was cancelled, discard the settlement
      if (exitResult || broke || entry.status === 'cancelled') {
        return;
      }

      switch (result.status) {
        case 'exited':
          entry.status = 'completed';
          exitResult = { reason: result.reason, failure: result.failure };

          cancelInFlight();

          emitter.emit('workflow_exited', { reason: result.reason, failure: result.failure });

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
            error: new NodeError('Node failed', 'ENGINE_NODE_FAILED', node.id, {
              nodeName: node.name,
              cause: result.error,
            }),
          });
      }
    });

    const tracked = promise.finally(() => inFlightSet.delete(tracked));
    inFlightSet.add(tracked);
  };

  const dispatchEligible = (): void => {
    // A skip can unblock dependents, so re-scan after any progress instead of recursing.
    let progressed: boolean;
    do {
      if (exitResult || broke || hasFailure || externalSignal?.aborted) {
        return;
      }

      progressed = false;

      for (const entry of state.values()) {
        // Re-check halt guards before each decision so a failure mid-scan stops peers too.
        if (exitResult || broke || hasFailure || externalSignal?.aborted) {
          return;
        }

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

        // A skipped dependency only cascades its skip when its node propagates skip. Control-flow
        // nodes (break/exit) settle their ordering edges but stay transparent to skip-propagation,
        // so a dependent of a skipped break/exit still runs.
        const anySkipped = deps.some((depId) => {
          const dep = state.get(depId);

          return dep?.status === 'skipped' && dep.node.propagatesSkip();
        });
        if (anySkipped) {
          entry.status = 'skipped';
          pendingCount--;
          emitter.emit('node_skipped', {
            nodeId: entry.node.id,
            nodeName: entry.node.displayName(),
          });
          progressed = true;

          continue;
        }

        let shouldRun: boolean;
        try {
          shouldRun = entry.node.evaluateIf(buildCtx());
        } catch (err) {
          // The original diagnostic (e.g. NodeError from evaluateIf) is preserved as cause.
          entry.status = 'failed';
          pendingCount--;
          hasFailure = true;
          emitter.emit('node_failed', {
            nodeId: entry.node.id,
            nodeName: entry.node.displayName(),
            error: new NodeError(
              'Failed to evaluate if expression',
              'ENGINE_NODE_IF_ERROR',
              entry.node.id,
              { nodeName: entry.node.name, cause: err }
            ),
          });

          return;
        }

        if (!shouldRun) {
          entry.status = 'skipped';
          pendingCount--;
          emitter.emit('node_skipped', {
            nodeId: entry.node.id,
            nodeName: entry.node.displayName(),
          });
          progressed = true;

          continue;
        }

        dispatchNode(entry);
      }
    } while (progressed);
  };

  dispatchEligible();

  // Wake on each settlement to dispatch newly-unblocked nodes. Stops as soon as exit/break is recorded or the external signal aborts — the in-flight drain is handled below.
  while (
    !(exitResult || broke || externalSignal?.aborted) &&
    (pendingCount > 0 || inFlightSet.size > 0)
  ) {
    if (inFlightSet.size === 0) {
      // A failure halted dispatch, leaving pending nodes undispatched; anything else means the graph is deadlocked.
      if (hasFailure) {
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

  // On external abort (and not already torn down by exit/break), mark in-flight nodes cancelled and
  // emit node_cancelled for each, mirroring the exit/break teardown.
  if (externalSignal?.aborted && !(exitResult || broke)) {
    cancelInFlight();
  }

  // Exit/break/external-abort drains all in-flight nodes at once, bounded by a single grace period so a node that ignores its abort can't hang the scheduler forever.
  if ((exitResult || broke || externalSignal?.aborted) && inFlightSet.size > 0) {
    const graceController = new AbortController();
    const graceTimeout = sleep(CANCELLATION_GRACE_MS, graceController.signal).then(
      () => 'grace' as const
    );

    const winner = await Promise.race([
      Promise.allSettled(inFlightSet).then(() => 'drained' as const),
      graceTimeout,
    ]);

    if (winner === 'grace') {
      // Detach un-settled promises so late rejections from nodes ignoring the abort can't surface as unhandled rejections after we return.
      for (const promise of inFlightSet) {
        promise.catch(() => undefined);
      }
    }

    // Clear the grace timer so a fast drain doesn't leave a 5-minute timeout keeping the process alive.
    graceController.abort();
  }

  if (exitResult) {
    return {
      outcome: 'exited',
      success: !exitResult.failure && !hasFailure,
      exitReason: exitResult.reason,
      nodeResults: new Map(needs),
    };
  }

  if (broke) {
    return { outcome: 'broke', success: !hasFailure, nodeResults: new Map(needs) };
  }

  return { outcome: 'completed', success: !hasFailure, nodeResults: new Map(needs) };
};
