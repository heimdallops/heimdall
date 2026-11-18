import '../../../../src/core/engine/nodes/approval.ts';
import '../../../../src/core/engine/nodes/bash.ts';

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EngineConfigError,
  EngineError,
  EngineValidationError,
} from '../../../../src/core/engine/errors.ts';
import type { NodeRunCompleted, NodeRunOptions } from '../../../../src/core/engine/nodes/base.ts';
import { BaseNode } from '../../../../src/core/engine/nodes/base.ts';
import { nodeRegistry } from '../../../../src/core/engine/nodes/registry.ts';
import { Workflow } from '../../../../src/core/engine/workflow.ts';
import type { EventOf } from './_events.ts';
import { recordEvents, resultOf } from './_events.ts';

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

/** A workflow whose single bash node writes its self.needs.A output to HEIMDALL_OUTPUT.
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

      it('throws EngineConfigError naming the id when a node inside a loop body collides with a top-level node id', async () => {
        const yaml = `
name: loop-body-dup
nodes:
  - id: build
    bash: "true"
  - id: wrap
    loop:
      max_iterations: 1
      nodes:
        - id: build
          bash: "true"
`;

        const err = await Workflow.from(yaml).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(EngineConfigError);
        expect((err as EngineConfigError).message).toContain('build');
        expect((err as EngineConfigError).message).toMatch(/Duplicate node id/);
      });

      it('throws EngineConfigError when a plain node uses a reserved word as its id', async () => {
        const yaml = `
name: plain-reserved-id
nodes:
  - id: each
    bash: "true"
`;

        const err = await Workflow.from(yaml).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(EngineConfigError);
        expect((err as EngineConfigError).message).toContain("Node id 'each' is reserved");
      });

      it('throws EngineConfigError when a loop node uses a reserved word as its own id', async () => {
        const yaml = `
name: loop-reserved-id
nodes:
  - id: loop
    loop:
      max_iterations: 1
      nodes:
        - id: inner
          bash: "true"
`;

        const err = await Workflow.from(yaml).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(EngineConfigError);
        expect((err as EngineConfigError).message).toContain("Node id 'loop' is reserved");
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
      const recorder = recordEvents();
      const started = recorder.collect('node.started');

      const runPromise = workflow.run({
        inputs: {}, // 'token' is not supplied
        onEvent: recorder.onEvent,
      });

      await expect(runPromise).rejects.toBeInstanceOf(EngineConfigError);

      // The key behavioral assertion: no node must have been started
      expect(started).toHaveLength(0);
    });

    it('includes the missing input name in the error message so the user knows what to supply', async () => {
      const workflow = await Workflow.from(workflowWithRequiredInput);

      const err = await workflow.run({ inputs: {} }).catch((e: unknown) => e);

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
      });

      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // workflow.run — integer input binding
  // -------------------------------------------------------------------------

  describe('workflow.run — integer inputs evaluate as a CEL int', () => {
    // '\x24{{ }}' avoids the JS template-literal parser treating ${ as an interpolation opener.
    const celMinusOne = '\x24{{ inputs.count - 1 }}';
    const celDivided = '\x24{{ inputs.count / 2 }}';

    const integerInputWorkflow = (expr: string, supplied: boolean): string => `
name: int-input
inputs:
  count:
    type: integer
${supplied ? '' : '    default: 6'}
nodes:
  - id: math
    bash: 'echo -n "${expr}" > "$HEIMDALL_OUTPUT"'
`;

    it.each([
      ['subtraction against an int literal', celMinusOne, '5'],
      ['integer division against an int literal', celDivided, '3'],
    ])('resolves %s on a supplied integer input', async (_label, expr, expected) => {
      const workflow = await Workflow.from(integerInputWorkflow(expr, true));
      const recorder = recordEvents();
      const completed = recorder.collect('node.completed');

      const result = await workflow.run({ inputs: { count: 6 }, onEvent: recorder.onEvent });

      expect(result.success).toBe(true);
      expect(resultOf(completed[0]!)['output']).toBe(expected);
    });

    it('resolves arithmetic on an integer input taken from its declared default', async () => {
      const workflow = await Workflow.from(integerInputWorkflow(celMinusOne, false));
      const recorder = recordEvents();
      const completed = recorder.collect('node.completed');

      const result = await workflow.run({ inputs: {}, onEvent: recorder.onEvent });

      expect(result.success).toBe(true);
      expect(resultOf(completed[0]!)['output']).toBe('5');
    });

    it('rejects a non-integer supplied for an integer input with EngineConfigError, naming the input', async () => {
      const workflow = await Workflow.from(integerInputWorkflow(celMinusOne, true));

      const err = await workflow.run({ inputs: { count: 1.5 } }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(EngineConfigError);
      expect((err as Error).message).toContain('count');
      expect((err as Error).message).toContain('1.5');
    });

    it('leaves a number-typed input as a double, so int-literal arithmetic fails', async () => {
      const numberInputWorkflow = `
name: num-input
inputs:
  ratio:
    type: number
nodes:
  - id: math
    bash: 'echo -n "\x24{{ inputs.ratio - 1 }}" > "$HEIMDALL_OUTPUT"'
`;
      const workflow = await Workflow.from(numberInputWorkflow);

      const result = await workflow.run({ inputs: { ratio: 6 } });

      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // workflow.run — single-run guard
  // -------------------------------------------------------------------------

  describe('workflow.run — single-run guard', () => {
    it('throws EngineError on a second call after the first run has completed', async () => {
      const workflow = await Workflow.from(minimalWorkflow);

      // First run must succeed
      const first = await workflow.run({ inputs: {} });
      expect(first.success).toBe(true);

      // Second call must be rejected
      await expect(workflow.run({ inputs: {} })).rejects.toBeInstanceOf(EngineError);
    });

    it('throws EngineError with a message that explains the guard semantics on a second call', async () => {
      const workflow = await Workflow.from(minimalWorkflow);
      await workflow.run({ inputs: {} });

      const err = await workflow.run({ inputs: {} }).catch((e: unknown) => e);

      expect((err as EngineError).message.toLowerCase()).toMatch(/once|already|single/);
    });

    it('rejects the second concurrent call while the first run resolves successfully', async () => {
      // The production guard sets `started = true` synchronously (after input resolution
      // but before the first await), so a second concurrent call must see it and reject.
      const workflow = await Workflow.from(minimalWorkflow);

      // Fire both calls without awaiting between them
      const first = workflow.run({ inputs: {} });
      const second = workflow.run({ inputs: {} });

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
  // workflow.run — run.completed event
  // -------------------------------------------------------------------------

  describe('workflow.run — run.completed event', () => {
    it('publishes run.completed with success: true after a successful workflow', async () => {
      const workflow = await Workflow.from(minimalWorkflow);
      const recorder = recordEvents();
      const completed = recorder.collect('run.completed');

      await workflow.run({ inputs: {}, onEvent: recorder.onEvent });

      expect(completed).toHaveLength(1);
      expect(completed[0]!.data.success).toBe(true);
    });

    it('publishes run.completed AFTER node lifecycle events (after node.completed for the last node)', async () => {
      const workflow = await Workflow.from(minimalWorkflow);
      const recorder = recordEvents();
      const eventLog: string[] = [];

      recorder.on('node.completed', () => eventLog.push('node.completed'));
      recorder.on('run.completed', () => eventLog.push('run.completed'));

      await workflow.run({ inputs: {}, onEvent: recorder.onEvent });

      const nodeCompletedIdx = eventLog.lastIndexOf('node.completed');
      const workflowCompletedIdx = eventLog.indexOf('run.completed');

      expect(workflowCompletedIdx).toBeGreaterThan(nodeCompletedIdx);
    });

    it('publishes run.completed with success: false when a node fails', async () => {
      const yaml = `
name: failing
nodes:
  - id: fail_step
    bash: "exit 1"
`;
      const workflow = await Workflow.from(yaml);
      const recorder = recordEvents();
      const completed = recorder.collect('run.completed');

      const result = await workflow.run({ inputs: {}, onEvent: recorder.onEvent });

      expect(completed).toHaveLength(1);
      expect(completed[0]!.data.success).toBe(false);
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // workflow.run — run events
  // -------------------------------------------------------------------------

  describe('workflow.run — run events', () => {
    const failingWorkflow = `
name: failing
nodes:
  - id: fail_step
    bash: "exit 1"
`;

    it('publishes run.started first and run.completed last on success', async () => {
      const workflow = await Workflow.from(minimalWorkflow);
      const recorder = recordEvents();

      await workflow.run({ inputs: {}, onEvent: recorder.onEvent, runId: 'run-abc', cwd: '/tmp' });

      const types = recorder.events.map((e) => e.type);
      expect(types[0]).toBe('run.started');
      expect(types.at(-1)).toBe('run.completed');
      expect(recorder.events[0]!.data).toEqual({
        workflow: 'minimal',
        cwd: '/tmp',
        runDirectory: join(xdgRoot, 'heimdall', 'runs', 'run-abc'),
      });
      expect(recorder.events.at(-1)!.data).toEqual({ success: true });
    });

    it('publishes run.completed with success: false and no error when a node fails', async () => {
      const workflow = await Workflow.from(failingWorkflow);
      const recorder = recordEvents();

      await workflow.run({ inputs: {}, onEvent: recorder.onEvent });

      expect(recorder.events[0]!.type).toBe('run.started');
      expect(recorder.events.at(-1)).toMatchObject({
        type: 'run.completed',
        data: { success: false },
      });
      expect(recorder.events.at(-1)!.data).not.toHaveProperty('error');
    });

    it('carries the exit reason on run.completed when an exit node ends the run', async () => {
      const yaml = `
name: exiting
nodes:
  - id: stop
    exit: { reason: done early }
`;
      const workflow = await Workflow.from(yaml);
      const recorder = recordEvents();

      await workflow.run({ inputs: {}, onEvent: recorder.onEvent });

      expect(recorder.events.at(-1)).toMatchObject({
        type: 'run.completed',
        data: { success: true, exitReason: 'done early' },
      });
    });

    it('still publishes run.started then run.completed with the error when the run directory cannot be created', async () => {
      // A file where the data directory should be makes mkdir fail.
      const blocker = join(xdgRoot, 'not-a-dir');
      await writeFile(blocker, '');
      vi.stubEnv('XDG_DATA_HOME', blocker);
      const workflow = await Workflow.from(minimalWorkflow);
      const recorder = recordEvents();

      await expect(workflow.run({ inputs: {}, onEvent: recorder.onEvent })).rejects.toThrow();

      expect(recorder.events.map((e) => e.type)).toEqual(['run.started', 'run.completed']);
      const last = recorder.events[1] as EventOf<'run.completed'>;
      expect(last.data.success).toBe(false);
      expect(last.data.error?.code).toBe('ENOTDIR');
    });

    it('uses the runId option for every event and for the run directory name', async () => {
      const workflow = await Workflow.from(failingWorkflow);
      const recorder = recordEvents();

      await workflow.run({ inputs: {}, onEvent: recorder.onEvent, runId: 'my-run' });

      expect(new Set(recorder.events.map((e) => e.runId))).toEqual(new Set(['my-run']));
      // A failed run keeps its directory.
      expect(await readdir(join(xdgRoot, 'heimdall', 'runs'))).toEqual(['my-run']);
    });

    it('numbers events from 1 with no gaps across a run with a loop', async () => {
      const yaml = `
name: looping
nodes:
  - id: before
    bash: "true"
  - id: repeat
    depends_on: [before]
    loop:
      max_iterations: 2
      nodes:
        - id: body
          bash: "true"
`;
      const workflow = await Workflow.from(yaml);
      const recorder = recordEvents();

      await workflow.run({ inputs: {}, onEvent: recorder.onEvent });

      expect(recorder.events.map((e) => e.sequence)).toEqual(recorder.events.map((_e, i) => i + 1));
      const bodyPaths = recorder.events
        .filter((e): e is EventOf<'node.started'> => e.type === 'node.started')
        .filter((e) => e.node.id === 'body')
        .map((e) => e.node.path);
      expect(bodyPaths).toEqual([
        ['repeat', 0, 'body'],
        ['repeat', 1, 'body'],
      ]);
    });

    it('reports a throwing onEvent to onSinkError and finishes the run', async () => {
      const workflow = await Workflow.from(minimalWorkflow);
      const sinkErrors: string[] = [];

      const result = await workflow.run({
        inputs: {},
        onEvent: () => {
          throw new Error('sink broke');
        },
        onSinkError: (_err, event) => sinkErrors.push(event.type),
      });

      expect(result.success).toBe(true);
      expect(sinkErrors[0]).toBe('run.started');
      expect(sinkErrors.at(-1)).toBe('run.completed');
    });
  });

  // -------------------------------------------------------------------------
  // workflow.run — success
  // -------------------------------------------------------------------------

  describe('workflow.run — successful execution', () => {
    it('resolves with success: true and actually runs the node (node.completed published)', async () => {
      const workflow = await Workflow.from(minimalWorkflow);
      const recorder = recordEvents();
      const completed = recorder.collect('node.completed');

      const result = await workflow.run({ inputs: {}, onEvent: recorder.onEvent });

      expect(result.success).toBe(true);
      // The node genuinely ran — not just a pass-through
      expect(completed).toHaveLength(1);
      expect(completed[0]!.node.id).toBe('step1');
    });
  });

  describe('workflow.run — heimdall.run_cwd', () => {
    // '\x24{{ }}' avoids the JS template-literal parser treating ${ as an interpolation
    // opener, matching the convention used by the chained-needs test below.
    const celRunCwd = '\x24{{ heimdall.run_cwd }}';
    const runCwdWorkflow = `
name: run-cwd
nodes:
  - id: step1
    bash: 'echo -n "${celRunCwd}" > "$HEIMDALL_OUTPUT"'
`;

    it('exposes the explicit run cwd option as heimdall.run_cwd to a CEL expression in a node', async () => {
      const explicitCwd = await mkdtemp(join(tmpdir(), 'heimdall-run-cwd-'));

      try {
        const workflow = await Workflow.from(runCwdWorkflow);
        const recorder = recordEvents();
        const completed = recorder.collect('node.completed');

        const result = await workflow.run({
          inputs: {},
          onEvent: recorder.onEvent,
          cwd: explicitCwd,
        });

        expect(result.success).toBe(true);
        expect(resultOf(completed[0]!)['output']).toBe(explicitCwd);
      } finally {
        await rm(explicitCwd, { recursive: true, force: true });
      }
    });

    it('falls back to process.cwd() as heimdall.run_cwd when no cwd option is supplied', async () => {
      const workflow = await Workflow.from(runCwdWorkflow);
      const recorder = recordEvents();
      const completed = recorder.collect('node.completed');

      const result = await workflow.run({ inputs: {}, onEvent: recorder.onEvent });

      expect(result.success).toBe(true);
      expect(resultOf(completed[0]!)['output']).toBe(process.cwd());
    });
  });

  // -------------------------------------------------------------------------
  // workflow.run — heimdall.session_dir
  // -------------------------------------------------------------------------

  describe('workflow.run — heimdall.session_dir', () => {
    it('exposes the run session directory as heimdall.session_dir to a CEL expression in a node', async () => {
      // '\x24{{ }}' avoids the JS template-literal parser treating ${ as an interpolation opener.
      const celSessionDir = '\x24{{ heimdall.session_dir }}';
      const yaml = `
name: session-dir
nodes:
  - id: step1
    bash: 'echo -n "${celSessionDir}" > "$HEIMDALL_OUTPUT"'
`;
      const workflow = await Workflow.from(yaml);
      const recorder = recordEvents();
      const completed = recorder.collect('node.completed');

      const result = await workflow.run({ inputs: {}, onEvent: recorder.onEvent });

      expect(result.success).toBe(true);
      const sessionDir = resultOf(completed[0]!)['output'] as string;
      // The run's session directory lives under XDG_DATA_HOME/heimdall/runs/<uuid>/session;
      // xdgRoot is stubbed per-test (see the outer beforeEach), so this proves
      // heimdall.session_dir resolves to the real, run-specific session directory rather
      // than an unrelated, stale, or hardcoded value.
      expect(sessionDir.startsWith(join(xdgRoot, 'heimdall', 'runs'))).toBe(true);
      expect(sessionDir.split(/[/\\]/).pop()).toBe('session');
    });
  });

  // -------------------------------------------------------------------------
  // workflow.run — cancellation via the signal option
  // -------------------------------------------------------------------------

  describe('workflow.run — signal cancellation', () => {
    it('cancels an in-flight node when the provided signal aborts', async () => {
      // sleep 30 would outlast the test timeout; the signal must cut the node short.
      // Without the signal threaded through, the run would hang here.
      const yaml = `
name: cancellable
nodes:
  - id: step1
    bash: "sleep 30"
`;
      const workflow = await Workflow.from(yaml);
      const recorder = recordEvents();
      const cancelled = recorder.collect('node.cancelled');
      const controller = new AbortController();

      // Abort the instant the node goes in-flight so we exercise mid-run cancellation,
      // not a pre-aborted no-op that never dispatches.
      recorder.on('node.started', () => {
        controller.abort();
      });

      await workflow.run({ inputs: {}, onEvent: recorder.onEvent, signal: controller.signal });

      expect(cancelled).toHaveLength(1);
      expect(cancelled[0]!.node.id).toBe('step1');
    });
  });

  // -------------------------------------------------------------------------
  // workflow.run — run directory lifecycle
  // -------------------------------------------------------------------------

  describe('workflow.run — run directory', () => {
    it('removes the run directory on success', async () => {
      const workflow = await Workflow.from(minimalWorkflow);

      await workflow.run({ inputs: {} });

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
      const result = await workflow.run({ inputs: {} });
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
    it('executes A, B, C in dependency order and publishes node.completed for each in correct sequence', async () => {
      const workflow = await Workflow.from(threeNodeChainWorkflow);
      const recorder = recordEvents();
      const events: string[] = [];

      recorder.on('node.started', (e) => events.push(`started:${e.node.id}`));
      recorder.on('node.completed', (e) => events.push(`completed:${e.node.id}`));

      const result = await workflow.run({ inputs: {}, onEvent: recorder.onEvent });

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
      // '\x24{{ }}' avoids the JS template-literal parser treating ${ as an interpolation opener.
      const celNodeA = '\x24{{ self.needs.nodeA.output }}';
      const celNodeB = '\x24{{ self.needs.nodeB.output }}';
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
      const recorder = recordEvents();
      const completed = recorder.collect('node.completed');

      const result = await workflow.run({ inputs: {}, onEvent: recorder.onEvent });

      expect(result.success).toBe(true);
      expect(completed).toHaveLength(3);

      // nodeB must have received nodeA's output and appended "-b"
      const nodeBEvent = completed.find((e) => e.node.id === 'nodeB');
      expect(nodeBEvent).toBeDefined();
      expect(resultOf(nodeBEvent!)['output']).toBe('value_a-b');

      // nodeC must have received nodeB's output ("value_a-b") and appended "-c",
      // proving the full chain A→B→C propagated correctly
      const nodeCEvent = completed.find((e) => e.node.id === 'nodeC');
      expect(nodeCEvent).toBeDefined();
      expect(resultOf(nodeCEvent!)['output']).toBe('value_a-b-c');
    });

    it('publishes node.started before node.completed for each node in the chain', async () => {
      const workflow = await Workflow.from(threeNodeChainWorkflow);
      const recorder = recordEvents();
      const eventLog: { event: string; nodeId: string }[] = [];

      recorder.on('node.started', (e) => eventLog.push({ event: 'started', nodeId: e.node.id }));
      recorder.on('node.completed', (e) =>
        eventLog.push({ event: 'completed', nodeId: e.node.id })
      );

      await workflow.run({ inputs: {}, onEvent: recorder.onEvent });

      for (const id of ['nodeA', 'nodeB', 'nodeC']) {
        const startedIdx = eventLog.findIndex((e) => e.event === 'started' && e.nodeId === id);
        const completedIdx = eventLog.findIndex((e) => e.event === 'completed' && e.nodeId === id);
        expect(startedIdx).toBeGreaterThanOrEqual(0);
        expect(completedIdx).toBeGreaterThan(startedIdx);
      }
    });
  });
});
