import '../../../src/core/engine/nodes/bash.ts';
import '../../../src/core/engine/nodes/exit.ts';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineEmitter, EngineEventMap } from '../../../src/core/engine/emitter.ts';
import { createEngineEmitter } from '../../../src/core/engine/emitter.ts';
import { Workflow } from '../../../src/core/engine/workflow.ts';

const collectEvents = <K extends keyof EngineEventMap>(
  emitter: EngineEmitter,
  event: K
): EngineEventMap[K][0][] => {
  const events: EngineEventMap[K][0][] = [];
  emitter.on(event, (payload) => {
    events.push(payload);
  });

  return events;
};

// These drive the full engine end to end — YAML parse, registry node construction, the
// scheduler, and real bash child processes — so they live with the integration tests.
// XDG_DATA_HOME is redirected to a temp dir so runs never touch the real user data dir; a
// failed exit (failure: true) deliberately preserves its run dir, which would otherwise
// accumulate under the real home directory.
describe('workflow.run — exit node (integration)', () => {
  let xdgRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    xdgRoot = await mkdtemp(join(tmpdir(), 'heimdall-engine-exit-test-'));
    vi.stubEnv('XDG_DATA_HOME', xdgRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(xdgRoot, { recursive: true, force: true });
  });

  it('resolves with success: true and surfaces exitReason when failure is false', async () => {
    const yaml = `
name: clean-exit
nodes:
  - id: done
    exit:
      reason: goal achieved
      failure: false
`;
    const workflow = await Workflow.from(yaml);

    const result = await workflow.run({ inputs: {} });

    expect(result.success).toBe(true);
    expect(result.exitReason).toBe('goal achieved');
  });

  it('resolves with success: false when the exit node declares failure: true', async () => {
    const yaml = `
name: failed-exit
nodes:
  - id: fatal
    exit:
      reason: fatal error
      failure: true
`;
    const workflow = await Workflow.from(yaml);

    const result = await workflow.run({ inputs: {} });

    expect(result.success).toBe(false);
    expect(result.exitReason).toBe('fatal error');
  });

  it('produces an undefined exitReason when the exit node omits reason', async () => {
    const yaml = `
name: exit-no-reason
nodes:
  - id: stopper
    exit: {}
`;
    const workflow = await Workflow.from(yaml);

    const result = await workflow.run({ inputs: {} });

    expect(result.exitReason).toBeUndefined();
  });

  it('emits workflow_exited with reason and failure before workflow_completed', async () => {
    const yaml = `
name: exit-events
nodes:
  - id: exiter
    exit:
      reason: done
      failure: false
`;
    const workflow = await Workflow.from(yaml);
    const emitter = createEngineEmitter();
    const eventLog: string[] = [];
    const exitEvents = collectEvents(emitter, 'workflow_exited');

    emitter.on('workflow_exited', () => eventLog.push('workflow_exited'));
    emitter.on('workflow_completed', () => eventLog.push('workflow_completed'));

    await workflow.run({ inputs: {}, emitter });

    // The event must have fired exactly once with the correct payload
    expect(exitEvents).toHaveLength(1);
    expect(exitEvents[0]!.reason).toBe('done');
    expect(exitEvents[0]!.failure).toBe(false);

    // The event must have fired before workflow_completed
    expect(eventLog.indexOf('workflow_exited')).toBeGreaterThanOrEqual(0);
    expect(eventLog.indexOf('workflow_completed')).toBeGreaterThan(
      eventLog.indexOf('workflow_exited')
    );
  });

  it('emits workflow_exited with the correct reason and failure values', async () => {
    const yaml = `
name: exit-payload
nodes:
  - id: exiter
    exit:
      reason: stopping now
      failure: true
`;
    const workflow = await Workflow.from(yaml);
    const emitter = createEngineEmitter();
    const exitEvents = collectEvents(emitter, 'workflow_exited');

    await workflow.run({ inputs: {}, emitter });

    expect(exitEvents).toHaveLength(1);
    expect(exitEvents[0]!.reason).toBe('stopping now');
    expect(exitEvents[0]!.failure).toBe(true);
  });

  it('does not run a node that depends on an exit node', async () => {
    const yaml = `
name: exit-stops-downstream
nodes:
  - id: exiter
    exit:
      reason: early stop
      failure: false
  - id: downstream
    depends_on: [exiter]
    bash: "exit 1"
`;
    const workflow = await Workflow.from(yaml);
    const emitter = createEngineEmitter();
    const started = collectEvents(emitter, 'node_started');

    await workflow.run({ inputs: {}, emitter });

    const startedIds = started.map((e) => e.nodeId);
    expect(startedIds).not.toContain('downstream');
  });

  it('cancels an in-flight parallel node when a concurrent exit node fires', async () => {
    // Two root nodes with no dependency between them: a clean exit and a long-running
    // bash node. The scheduler dispatches both concurrently; when the exit node settles
    // first it triggers cancelInFlight(), which aborts the bash process via its
    // cancel signal. The scheduler must drain the cancelled node and resolve.
    const yaml = `
name: exit-cancels-inflight
nodes:
  - id: exiter
    exit:
      failure: false
  - id: slow
    bash: "sleep 60"
`;
    const workflow = await Workflow.from(yaml);
    const emitter = createEngineEmitter();
    const started = collectEvents(emitter, 'node_started');
    const cancelled = collectEvents(emitter, 'node_cancelled');

    const result = await workflow.run({ inputs: {}, emitter });

    expect(result.success).toBe(true);
    // The slow node must have been dispatched into the in-flight state before being
    // cancelled — if it was never dispatched the cancellation would prove nothing.
    const startedIds = started.map((e) => e.nodeId);
    expect(startedIds).toContain('slow');
    const cancelledIds = cancelled.map((e) => e.nodeId);
    expect(cancelledIds).toContain('slow');
  });

  it('runs a node that depends on a skipped exit node — skipped exit does not cascade its skip', async () => {
    // Regression test for propagatesSkip() returning false on ExitNode.
    // Before the fix, a skipped exit (if: evaluates to false) would cascade its skip
    // to dependents, silently preventing them from running. After the fix, the
    // dependent must still execute and no workflow_exited event must be emitted
    // (the exit never fires).
    const yaml = `
name: skipped-exit-no-cascade
nodes:
  - id: gated_exit
    if: "false"
    exit:
      failure: false
  - id: after_exit
    depends_on: [gated_exit]
    bash: "true"
`;
    const workflow = await Workflow.from(yaml);
    const emitter = createEngineEmitter();
    const started = collectEvents(emitter, 'node_started');
    const exitEvents = collectEvents(emitter, 'workflow_exited');

    const result = await workflow.run({ inputs: {}, emitter });

    // The dependent node must have run
    const startedIds = started.map((e) => e.nodeId);
    expect(startedIds).toContain('after_exit');
    // The exit never fired, so no workflow_exited event
    expect(exitEvents).toHaveLength(0);
    // The workflow completed normally (not via exit)
    expect(result.success).toBe(true);
    expect(result.exitReason).toBeUndefined();
  });

  it('emits workflow_completed with success: true after a clean exit', async () => {
    const yaml = `
name: exit-workflow-completed
nodes:
  - id: stopper
    exit:
      reason: all done
      failure: false
`;
    const workflow = await Workflow.from(yaml);
    const emitter = createEngineEmitter();
    const completed = collectEvents(emitter, 'workflow_completed');

    await workflow.run({ inputs: {}, emitter });

    expect(completed).toHaveLength(1);
    expect(completed[0]!.success).toBe(true);
  });
});
