import '../../../src/core/engine/nodes/bash.ts';
import '../../../src/core/engine/nodes/exit.ts';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Workflow } from '../../../src/core/engine/workflow.ts';
import { recordEvents } from '../../unit/core/engine/_events.ts';

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

  it('publishes run.exited with reason and failure before run.completed', async () => {
    const yaml = `
name: exit-events
nodes:
  - id: exiter
    exit:
      reason: done
      failure: false
`;
    const workflow = await Workflow.from(yaml);
    const recorder = recordEvents();
    const eventLog: string[] = [];
    const exitEvents = recorder.collect('run.exited');

    recorder.on('run.exited', () => eventLog.push('run.exited'));
    recorder.on('run.completed', () => eventLog.push('run.completed'));

    await workflow.run({ inputs: {}, onEvent: recorder.onEvent });

    // The event must have fired exactly once with the correct payload
    expect(exitEvents).toHaveLength(1);
    expect(exitEvents[0]!.data.reason).toBe('done');
    expect(exitEvents[0]!.data.failure).toBe(false);

    // The event must have fired before run.completed
    expect(eventLog.indexOf('run.exited')).toBeGreaterThanOrEqual(0);
    expect(eventLog.indexOf('run.completed')).toBeGreaterThan(eventLog.indexOf('run.exited'));
  });

  it('publishes run.exited with the correct reason and failure values', async () => {
    const yaml = `
name: exit-payload
nodes:
  - id: exiter
    exit:
      reason: stopping now
      failure: true
`;
    const workflow = await Workflow.from(yaml);
    const recorder = recordEvents();
    const exitEvents = recorder.collect('run.exited');

    await workflow.run({ inputs: {}, onEvent: recorder.onEvent });

    expect(exitEvents).toHaveLength(1);
    expect(exitEvents[0]!.data.reason).toBe('stopping now');
    expect(exitEvents[0]!.data.failure).toBe(true);
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
    const recorder = recordEvents();
    const started = recorder.collect('node.started');

    await workflow.run({ inputs: {}, onEvent: recorder.onEvent });

    const startedIds = started.map((e) => e.node.id);
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
    const recorder = recordEvents();
    const started = recorder.collect('node.started');
    const cancelled = recorder.collect('node.cancelled');

    const result = await workflow.run({ inputs: {}, onEvent: recorder.onEvent });

    expect(result.success).toBe(true);
    // The slow node must have been dispatched into the in-flight state before being
    // cancelled — if it was never dispatched the cancellation would prove nothing.
    const startedIds = started.map((e) => e.node.id);
    expect(startedIds).toContain('slow');
    const cancelledIds = cancelled.map((e) => e.node.id);
    expect(cancelledIds).toContain('slow');
  });

  it('runs a node that depends on a skipped exit node — skipped exit does not cascade its skip', async () => {
    // Regression test for propagatesSkip() returning false on ExitNode.
    // Before the fix, a skipped exit (if: evaluates to false) would cascade its skip
    // to dependents, silently preventing them from running. After the fix, the
    // dependent must still execute and no run.exited event must be published
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
    const recorder = recordEvents();
    const started = recorder.collect('node.started');
    const exitEvents = recorder.collect('run.exited');

    const result = await workflow.run({ inputs: {}, onEvent: recorder.onEvent });

    // The dependent node must have run
    const startedIds = started.map((e) => e.node.id);
    expect(startedIds).toContain('after_exit');
    // The exit never fired, so no run.exited event
    expect(exitEvents).toHaveLength(0);
    // The workflow completed normally (not via exit)
    expect(result.success).toBe(true);
    expect(result.exitReason).toBeUndefined();
  });

  it('publishes run.completed with success: true after a clean exit', async () => {
    const yaml = `
name: exit-workflow-completed
nodes:
  - id: stopper
    exit:
      reason: all done
      failure: false
`;
    const workflow = await Workflow.from(yaml);
    const recorder = recordEvents();
    const completed = recorder.collect('run.completed');

    await workflow.run({ inputs: {}, onEvent: recorder.onEvent });

    expect(completed).toHaveLength(1);
    expect(completed[0]!.data.success).toBe(true);
  });
});
