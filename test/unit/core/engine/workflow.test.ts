import '../../../../src/core/engine/nodes/approval.ts';
import '../../../../src/core/engine/nodes/bash.ts';

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineEmitter, EngineEventMap } from '../../../../src/core/engine/emitter.ts';
import { createEngineEmitter } from '../../../../src/core/engine/emitter.ts';
import {
  EngineConfigError,
  EngineError,
  EngineValidationError,
} from '../../../../src/core/engine/errors.ts';
import type {
  NodeRunCompleted,
  NodeRunOptions,
  PlatformAdapter,
} from '../../../../src/core/engine/nodes/base.ts';
import { BaseNode } from '../../../../src/core/engine/nodes/base.ts';
import { nodeRegistry } from '../../../../src/core/engine/nodes/registry.ts';
import { Workflow } from '../../../../src/core/engine/workflow.ts';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const fakeAdapter: PlatformAdapter = {
  run: vi.fn(),
  findAgent: vi.fn(),
  parseAgent: vi.fn(),
};

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

// ---------------------------------------------------------------------------
// Minimal valid YAML helpers
// ---------------------------------------------------------------------------

/** A workflow with a single bash node that writes nothing to HEIMDALL_OUTPUT. */
const minimalWorkflow = `
name: minimal
nodes:
  - id: step1
    bash: "true"
`;

/** A workflow with declared inputs. */
const workflowWithInputs = `
name: with-inputs
inputs:
  env:
    type: string
  region:
    type: string
    default: us-east-1
nodes:
  - id: step1
    bash: "true"
`;

/** A workflow with a required input but no default. */
const workflowWithRequiredInput = `
name: needs-input
inputs:
  token:
    type: string
nodes:
  - id: step1
    bash: "true"
`;

/** A workflow whose single bash node writes its needs.A output to HEIMDALL_OUTPUT.
 *  Used for the three-node chain test.  All three are bash nodes so the workflow
 *  parses them without needing stub injection. */
const threeNodeChainWorkflow = `
name: chain
nodes:
  - id: nodeA
    bash: 'echo -n "value_a" > "$HEIMDALL_OUTPUT"'
  - id: nodeB
    depends_on: [nodeA]
    bash: 'echo -n "from_b" > "$HEIMDALL_OUTPUT"'
  - id: nodeC
    depends_on: [nodeB]
    bash: 'echo -n "from_c" > "$HEIMDALL_OUTPUT"'
`;

// ---------------------------------------------------------------------------
// Run-directory isolation
// ---------------------------------------------------------------------------
// We override XDG_DATA_HOME to a temp dir so tests never pollute the real
// user data directory and can assert directory creation/cleanup deterministically.

describe('Workflow', () => {
  let xdgRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    xdgRoot = await mkdtemp(join(tmpdir(), 'heimdall-engine-test-'));
    vi.stubEnv('XDG_DATA_HOME', xdgRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(xdgRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Workflow.from — validation errors
  // -------------------------------------------------------------------------

  describe('Workflow.from', () => {
    describe('malformed YAML', () => {
      it('throws EngineValidationError with a descriptive message when the YAML is syntactically invalid', async () => {
        const bad = 'name: [unclosed bracket';

        const err = await Workflow.from(bad).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(EngineValidationError);
        const { cause } = err as EngineValidationError;
        expect(cause).toBeInstanceOf(Error);
        expect((cause as Error).name).toBe('YAMLException');
        expect((cause as Error).message.length).toBeGreaterThan(0);
      });
    });

    describe('schema validation failure', () => {
      // Narrow type for a Zod issue — only the fields we assert on, no `any`.
      interface ZodIssueSummary {
        code: string;
        path: (string | number)[];
        minimum?: number;
      }

      it('throws EngineValidationError when the workflow is missing the required name field', async () => {
        const yaml = `
nodes:
  - id: step1
    bash: "true"
`;

        const err = await Workflow.from(yaml).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(EngineValidationError);
        const cause = (err as EngineValidationError).cause as { issues?: ZodIssueSummary[] };
        expect(cause).toBeDefined();
        expect(Array.isArray(cause.issues)).toBe(true);
        const nameIssue = cause.issues!.find((i) => i.path.length === 1 && i.path[0] === 'name');
        expect(nameIssue).toBeDefined();
        expect(nameIssue!.code).toBe('invalid_type');
      });

      it('throws EngineValidationError when nodes is an empty array (schema requires min 1)', async () => {
        const yaml = `
name: empty-nodes
nodes: []
`;

        const err = await Workflow.from(yaml).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(EngineValidationError);
        const cause = (err as EngineValidationError).cause as { issues?: ZodIssueSummary[] };
        expect(cause).toBeDefined();
        expect(Array.isArray(cause.issues)).toBe(true);
        const nodesIssue = cause.issues!.find((i) => i.path.length === 1 && i.path[0] === 'nodes');
        expect(nodesIssue).toBeDefined();
        expect(nodesIssue!.code).toBe('too_small');
        expect(nodesIssue!.minimum).toBe(1);
      });

      it('throws EngineValidationError when a node has an unrecognized shape (no known node-type key)', async () => {
        const yaml = `
name: bad-node
nodes:
  - id: step1
    unknown_key: value
`;

        const err = await Workflow.from(yaml).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(EngineValidationError);
        const msg = (err as EngineValidationError).message.toLowerCase();
        expect(msg).toContain('unrecognized');
        expect(msg).toContain('step1');
      });
    });

    describe('DAG structural errors', () => {
      it('throws EngineConfigError when a node references an unknown depends_on id', async () => {
        const yaml = `
name: bad-dep
nodes:
  - id: step1
    bash: "true"
    depends_on: [ghost]
`;

        const err = await Workflow.from(yaml).catch((e: unknown) => e);
        expect((err as EngineConfigError).message).toContain('ghost');
      });

      it('throws EngineConfigError when depends_on forms a cycle', async () => {
        const yaml = `
name: cyclic
nodes:
  - id: nodeA
    bash: "true"
    depends_on: [nodeB]
  - id: nodeB
    bash: "true"
    depends_on: [nodeA]
`;

        const err = await Workflow.from(yaml).catch((e: unknown) => e);
        expect((err as EngineConfigError).message).toMatch(/nodeA|nodeB/);
      });

      it('throws EngineConfigError naming the duplicated id when two top-level nodes share the same id', async () => {
        const yaml = `
name: dup-ids
nodes:
  - id: step1
    bash: "true"
  - id: step1
    bash: "echo duplicate"
`;

        const err = await Workflow.from(yaml).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(EngineConfigError);
        expect((err as EngineConfigError).message).toContain('step1');
        expect((err as EngineConfigError).message).toMatch(/Duplicate node id/);
      });

      it('throws EngineConfigError when a BreakNode appears at the top level', async () => {
        const yaml = `
name: top-level-break
nodes:
  - id: breaker
    break: ~
`;

        const err = await Workflow.from(yaml).catch((e: unknown) => e);
        expect((err as EngineConfigError).message).toContain('breaker');
      });
    });

    describe('node.validate() called during DAG validation', () => {
      it('returns a resolved Workflow when all nodes pass validate()', async () => {
        const workflow = await Workflow.from(minimalWorkflow);

        expect(workflow).toBeInstanceOf(Workflow);
        // The workflow exposes a non-empty inputs map only when inputs are declared;
        // for the minimal workflow, the map is empty — asserting size is a meaningful check.
        expect(workflow.inputs.size).toBe(0);
      });

      it('rejects with EngineConfigError and the specific validate() reason when a node validate() throws', async () => {
        // Register a test-only node type whose validate() throws EngineConfigError.
        //
        // Isolation: nodeRegistry has no unregister/reset — the type array is private and
        // append-only. Registration is done here (inside the test, as late as possible) and
        // is safe because matches() keys off 'test_fail_validate', a field that no real
        // workflow YAML uses, so the registered type is inert for every other test.
        class FailingValidateNode extends BaseNode<NodeRunCompleted> {
          public static matches(raw: Record<string, unknown>): boolean {
            return 'test_fail_validate' in raw;
          }

          public static parse(raw: Record<string, unknown>): BaseNode {
            return new FailingValidateNode({ id: raw['id'] as string });
          }

          public override validate(): void {
            throw new EngineConfigError(`node '${this.id}' is invalid for test reasons`);
          }
          public override run(_o: NodeRunOptions): Promise<NodeRunCompleted> {
            return Promise.resolve({ status: 'completed', result: { output: '' } });
          }
        }
        nodeRegistry.register(FailingValidateNode);

        const yaml = `
name: fail-validate
nodes:
  - id: bad
    test_fail_validate: true
`;

        const err = await Workflow.from(yaml).catch((e: unknown) => e);

        // The engine must surface the specific validate() reason, not swallow it.
        expect(err).toBeInstanceOf(EngineConfigError);
        expect((err as EngineConfigError).message).toContain('test reasons');
        expect((err as EngineConfigError).message).toContain('bad');
      });
    });
  });

  // -------------------------------------------------------------------------
  // workflow.inputs
  // -------------------------------------------------------------------------

  describe('workflow.inputs', () => {
    it('returns an empty map when the workflow declares no inputs', async () => {
      const workflow = await Workflow.from(minimalWorkflow);

      expect(workflow.inputs.size).toBe(0);
    });

    it('returns each declared input name with its declaration when inputs are defined', async () => {
      const workflow = await Workflow.from(workflowWithInputs);

      expect(workflow.inputs.size).toBe(2);
      expect(workflow.inputs.has('env')).toBe(true);
      expect(workflow.inputs.has('region')).toBe(true);
    });

    it('reflects the default value on an input declaration that has one', async () => {
      const workflow = await Workflow.from(workflowWithInputs);

      const regionDecl = workflow.inputs.get('region');
      expect(regionDecl).toBeDefined();
      expect(regionDecl!.default).toBe('us-east-1');
    });

    it('reflects no default on an input declaration that has none', async () => {
      const workflow = await Workflow.from(workflowWithInputs);

      const envDecl = workflow.inputs.get('env');
      expect(envDecl).toBeDefined();
      expect(envDecl!.default).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // workflow.run — input resolution
  // -------------------------------------------------------------------------

  describe('workflow.run — missing required input (FR-025)', () => {
    it('throws EngineConfigError before any node runs when a required input has no runtime value and no default', async () => {
      const workflow = await Workflow.from(workflowWithRequiredInput);
      const emitter = createEngineEmitter();
      const started = collectEvents(emitter, 'node_started');

      const runPromise = workflow.run({
        inputs: {}, // 'token' is not supplied
        emitter,
        adapter: fakeAdapter,
      });

      await expect(runPromise).rejects.toBeInstanceOf(EngineConfigError);

      // The key behavioral assertion: no node must have been started
      expect(started).toHaveLength(0);
    });

    it('includes the missing input name in the error message so the user knows what to supply', async () => {
      const workflow = await Workflow.from(workflowWithRequiredInput);

      const err = await workflow.run({ inputs: {}, adapter: fakeAdapter }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(EngineConfigError);
      expect((err as EngineConfigError).message).toContain('token');
    });
  });

  describe('workflow.run — default input resolution', () => {
    it('succeeds using the declared default when the runtime inputs omit an optional input', async () => {
      // 'region' has a default of 'us-east-1'; 'env' is required and must be supplied
      const workflow = await Workflow.from(workflowWithInputs);

      const result = await workflow.run({
        inputs: { env: 'production' }, // omit region — should use default
        adapter: fakeAdapter,
      });

      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // workflow.run — single-run guard
  // -------------------------------------------------------------------------

  describe('workflow.run — single-run guard', () => {
    it('throws EngineError on a second call after the first run has completed', async () => {
      const workflow = await Workflow.from(minimalWorkflow);

      // First run must succeed
      const first = await workflow.run({ inputs: {}, adapter: fakeAdapter });
      expect(first.success).toBe(true);

      // Second call must be rejected
      await expect(workflow.run({ inputs: {}, adapter: fakeAdapter })).rejects.toBeInstanceOf(
        EngineError
      );
    });

    it('throws EngineError with a message that explains the guard semantics on a second call', async () => {
      const workflow = await Workflow.from(minimalWorkflow);
      await workflow.run({ inputs: {}, adapter: fakeAdapter });

      const err = await workflow.run({ inputs: {}, adapter: fakeAdapter }).catch((e: unknown) => e);

      expect((err as EngineError).message.toLowerCase()).toMatch(/once|already|single/);
    });

    it('rejects the second concurrent call while the first run resolves successfully', async () => {
      // The production guard sets `started = true` synchronously (after input resolution
      // but before the first await), so a second concurrent call must see it and reject.
      const workflow = await Workflow.from(minimalWorkflow);

      // Fire both calls without awaiting between them
      const first = workflow.run({ inputs: {}, adapter: fakeAdapter });
      const second = workflow.run({ inputs: {}, adapter: fakeAdapter });

      // The first must complete successfully; the second must be rejected with EngineError
      const [firstResult] = await Promise.allSettled([first, second]);

      expect(firstResult.status).toBe('fulfilled');
      if (firstResult.status === 'fulfilled') {
        expect(firstResult.value.success).toBe(true);
      }

      await expect(second).rejects.toBeInstanceOf(EngineError);
    });
  });

  // -------------------------------------------------------------------------
  // workflow.run — workflow_completed event
  // -------------------------------------------------------------------------

  describe('workflow.run — workflow_completed event', () => {
    it('emits workflow_completed with success: true after a successful workflow', async () => {
      const workflow = await Workflow.from(minimalWorkflow);
      const emitter = createEngineEmitter();
      const completed = collectEvents(emitter, 'workflow_completed');

      await workflow.run({ inputs: {}, emitter, adapter: fakeAdapter });

      expect(completed).toHaveLength(1);
      expect(completed[0]!.success).toBe(true);
    });

    it('emits workflow_completed AFTER node lifecycle events (after node_completed for the last node)', async () => {
      const workflow = await Workflow.from(minimalWorkflow);
      const emitter = createEngineEmitter();
      const eventLog: string[] = [];

      emitter.on('node_completed', () => eventLog.push('node_completed'));
      emitter.on('workflow_completed', () => eventLog.push('workflow_completed'));

      await workflow.run({ inputs: {}, emitter, adapter: fakeAdapter });

      const nodeCompletedIdx = eventLog.lastIndexOf('node_completed');
      const workflowCompletedIdx = eventLog.indexOf('workflow_completed');

      expect(workflowCompletedIdx).toBeGreaterThan(nodeCompletedIdx);
    });

    it('emits workflow_completed with success: false when a node fails', async () => {
      const yaml = `
name: failing
nodes:
  - id: fail_step
    bash: "exit 1"
`;
      const workflow = await Workflow.from(yaml);
      const emitter = createEngineEmitter();
      const completed = collectEvents(emitter, 'workflow_completed');

      const result = await workflow.run({ inputs: {}, emitter, adapter: fakeAdapter });

      expect(completed).toHaveLength(1);
      expect(completed[0]!.success).toBe(false);
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // workflow.run — success
  // -------------------------------------------------------------------------

  describe('workflow.run — successful execution', () => {
    it('resolves with success: true and actually runs the node (node_completed emitted)', async () => {
      const workflow = await Workflow.from(minimalWorkflow);
      const emitter = createEngineEmitter();
      const completed = collectEvents(emitter, 'node_completed');

      const result = await workflow.run({ inputs: {}, emitter, adapter: fakeAdapter });

      expect(result.success).toBe(true);
      // The node genuinely ran — not just a pass-through
      expect(completed).toHaveLength(1);
      expect(completed[0]!.nodeId).toBe('step1');
    });
  });

  // -------------------------------------------------------------------------
  // workflow.run — run directory lifecycle
  // -------------------------------------------------------------------------

  describe('workflow.run — run directory', () => {
    it('removes the run directory on success', async () => {
      const workflow = await Workflow.from(minimalWorkflow);

      await workflow.run({ inputs: {}, adapter: fakeAdapter });

      // After a successful run, heimdall/runs/ should be empty (or missing)
      const runsDir = join(xdgRoot, 'heimdall', 'runs');
      const entries = await readdir(runsDir);

      expect(entries).toHaveLength(0);
    });

    it('leaves the run directory in place when the workflow fails', async () => {
      const yaml = `
name: failing-run-dir
nodes:
  - id: bad_step
    bash: "exit 1"
`;
      const workflow = await Workflow.from(yaml);

      // Assert the failure path is genuinely exercised before checking the run dir
      const result = await workflow.run({ inputs: {}, adapter: fakeAdapter });
      expect(result.success).toBe(false);

      const runsDir = join(xdgRoot, 'heimdall', 'runs');
      const entries = await readdir(runsDir);
      expect(entries.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Independent acceptance test: three-node chain A → B → C
  // -------------------------------------------------------------------------

  describe('three-node chain: execution order and chained needs (independent acceptance test)', () => {
    it('executes A, B, C in dependency order and emits node_completed for each in correct sequence', async () => {
      const workflow = await Workflow.from(threeNodeChainWorkflow);
      const emitter = createEngineEmitter();
      const events: string[] = [];

      emitter.on('node_started', (e) => events.push(`started:${e.nodeId}`));
      emitter.on('node_completed', (e) => events.push(`completed:${e.nodeId}`));

      const result = await workflow.run({ inputs: {}, emitter, adapter: fakeAdapter });

      expect(result.success).toBe(true);

      expect(events).toEqual([
        'started:nodeA',
        'completed:nodeA',
        'started:nodeB',
        'completed:nodeB',
        'started:nodeC',
        'completed:nodeC',
      ]);
    });

    it('gives nodeC access to nodeB output via needs (chained context)', async () => {
      // nodeA writes "value_a", nodeB reads it via ${{ needs.nodeA.output }} and appends "-b",
      // nodeC reads nodeB's output via ${{ needs.nodeB.output }} and appends "-c".
      // The final output on nodeC proves the needs chain flowed A→B→C through CEL interpolation.
      //
      // CEL interpolation syntax: ${{ needs.<id>.output }} — verified against:
      //   - bash.ts: passes ctx (including ctx.needs Map) through interpolate()
      //   - cel.ts: sanitize() converts Maps to plain objects via mapToObj(), so
      //     needs.nodeB.output accesses needs['nodeB']['output'] after conversion
      //   - bash.test.ts: confirms ${{ inputs.name }} pattern works (same interpolate path)
      //
      // Note: the ${{ }} tokens below are written using '\x24{{ }}' to prevent the JS
      // template-literal parser from treating ${ as an interpolation opener.
      const celNodeA = '\x24{{ needs.nodeA.output }}';
      const celNodeB = '\x24{{ needs.nodeB.output }}';
      const yaml = `
name: chain-needs
nodes:
  - id: nodeA
    bash: 'echo -n "value_a" > "$HEIMDALL_OUTPUT"'
  - id: nodeB
    depends_on: [nodeA]
    bash: 'echo -n "${celNodeA}-b" > "$HEIMDALL_OUTPUT"'
  - id: nodeC
    depends_on: [nodeB]
    bash: 'echo -n "${celNodeB}-c" > "$HEIMDALL_OUTPUT"'
`;
      const workflow = await Workflow.from(yaml);
      const emitter = createEngineEmitter();
      const completed = collectEvents(emitter, 'node_completed');

      const result = await workflow.run({ inputs: {}, emitter, adapter: fakeAdapter });

      expect(result.success).toBe(true);
      expect(completed).toHaveLength(3);

      // nodeB must have received nodeA's output and appended "-b"
      const nodeBEvent = completed.find((e) => e.nodeId === 'nodeB');
      expect(nodeBEvent).toBeDefined();
      expect(nodeBEvent!.result['output']).toBe('value_a-b');

      // nodeC must have received nodeB's output ("value_a-b") and appended "-c",
      // proving the full chain A→B→C propagated correctly
      const nodeCEvent = completed.find((e) => e.nodeId === 'nodeC');
      expect(nodeCEvent).toBeDefined();
      expect(nodeCEvent!.result['output']).toBe('value_a-b-c');
    });

    it('emits node_started before node_completed for each node in the chain', async () => {
      const workflow = await Workflow.from(threeNodeChainWorkflow);
      const emitter = createEngineEmitter();
      const eventLog: { event: string; nodeId: string }[] = [];

      emitter.on('node_started', (e) => eventLog.push({ event: 'started', nodeId: e.nodeId }));
      emitter.on('node_completed', (e) => eventLog.push({ event: 'completed', nodeId: e.nodeId }));

      await workflow.run({ inputs: {}, emitter, adapter: fakeAdapter });

      for (const id of ['nodeA', 'nodeB', 'nodeC']) {
        const startedIdx = eventLog.findIndex((e) => e.event === 'started' && e.nodeId === id);
        const completedIdx = eventLog.findIndex((e) => e.event === 'completed' && e.nodeId === id);
        expect(startedIdx).toBeGreaterThanOrEqual(0);
        expect(completedIdx).toBeGreaterThan(startedIdx);
      }
    });
  });
});
