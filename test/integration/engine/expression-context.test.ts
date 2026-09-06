import '../../../src/core/engine/nodes/bash.ts';
import '../../../src/core/engine/nodes/break.ts';
import '../../../src/core/engine/nodes/loop.ts';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  EngineEmitter,
  EngineEventMap,
  NodeResult,
} from '../../../src/core/engine/emitter.ts';
import { createEngineEmitter } from '../../../src/core/engine/emitter.ts';
import type { WorkflowResult } from '../../../src/core/engine/workflow.ts';
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

interface RunOutcome {
  readonly result: WorkflowResult;
  readonly started: EngineEventMap['node_started'][0][];
  readonly completed: EngineEventMap['node_completed'][0][];
  readonly failed: EngineEventMap['node_failed'][0][];
}

const runWorkflow = async (yaml: string): Promise<RunOutcome> => {
  const workflow = await Workflow.from(yaml);
  const emitter = createEngineEmitter();
  const started = collectEvents(emitter, 'node_started');
  const completed = collectEvents(emitter, 'node_completed');
  const failed = collectEvents(emitter, 'node_failed');

  const result = await workflow.run({ inputs: {}, emitter });

  return { result, started, completed, failed };
};

// A node inside a loop completes once per body execution, so these return one entry per
// execution, in order.
const resultsOf = (run: RunOutcome, nodeId: string): NodeResult[] =>
  run.completed.filter((event) => event.nodeId === nodeId).map((event) => event.result);

const outputsOf = (run: RunOutcome, nodeId: string): unknown[] =>
  resultsOf(run, nodeId).map((result) => result['output']);

const loopOutputsOf = (run: RunOutcome, nodeId: string, execution = 0): Record<string, unknown> => {
  const result = resultsOf(run, nodeId)[execution];
  if (result === undefined) {
    throw new Error(`Node '${nodeId}' did not complete ${execution + 1} time(s)`);
  }

  return result['output'] as Record<string, unknown>;
};

const startedIds = (run: RunOutcome): string[] => run.started.map((event) => event.nodeId);

// Empty when the node never failed.
const failureTextFor = (run: RunOutcome, nodeId: string): string =>
  run.failed
    .filter((event) => event.nodeId === nodeId)
    .map((event) => String(event.error))
    .join('\n');

const indentBlock = (block: string, spaces: number): string =>
  block
    .split('\n')
    .map((line) => (line === '' ? line : `${' '.repeat(spaces)}${line}`))
    .join('\n');

// `${{ … }}` is written `\${{ … }}` throughout so the JS template-literal parser does not read
// `${` as an interpolation opener; the workflow text itself carries the normal spelling.
const NAMED_ANCESTOR_NODES = `
- id: seed
  bash: 'echo -n baseline > "$HEIMDALL_OUTPUT"'
- id: ci
  depends_on: [seed]
  loop:
    max_iterations: 2
    nodes:
      - id: retry
        loop:
          max_iterations: 2
          nodes:
            - id: work
              bash: 'echo -n "c\${{ scopes.ci.index }}r\${{ scopes.retry.index }}" > "$HEIMDALL_OUTPUT"'
            - id: seed_read
              depends_on: [work]
              bash: 'echo -n "seed=\${{ scopes.ci.needs.seed.output }}" > "$HEIMDALL_OUTPUT"'
            - id: prev_read
              depends_on: [work]
              bash: 'echo -n "prev=\${{ has(scopes.retry.prev.work) ? scopes.retry.prev.work.output : "none" }}" > "$HEIMDALL_OUTPUT"'
          outputs:
            last: 'self.nodes.work.output'
    outputs:
      last: 'self.nodes.retry.output.last'
`.trim();

const namedAncestorsWorkflow = `
name: named-ancestors
nodes:
${indentBlock(NAMED_ANCESTOR_NODES, 2)}
`;

const checkpointVantageWorkflow = (retryOutputs: string): string => `
name: checkpoint-vantage
nodes:
  - id: ci
    loop:
      max_iterations: 2
      nodes:
        - id: retry
          loop:
            max_iterations: 2
            nodes:
              - id: work
                bash: 'echo -n done > "$HEIMDALL_OUTPUT"'
            outputs:
${indentBlock(retryOutputs, 14)}
`;

// These drive the full engine end to end — YAML parse, registry node construction, the
// scheduler, and real bash child processes — so they live with the integration tests.
// XDG_DATA_HOME is redirected to a temp dir so runs never touch the real user data dir; a
// failing run deliberately preserves its run dir, which would otherwise accumulate under the
// real home directory. The redirect is file-wide so a workflow several assertions describe can
// run once in beforeAll — each run spawns a bash process per body node per iteration.
//
// Body nodes write to $HEIMDALL_OUTPUT rather than stdout because BashNode inherits stdout:
// the node result is the observable form of the values a node prints.
describe('workflow.run — expression context (integration)', () => {
  let xdgRoot: string;

  beforeAll(async () => {
    xdgRoot = await mkdtemp(join(tmpdir(), 'heimdall-engine-expression-context-test-'));
    vi.stubEnv('XDG_DATA_HOME', xdgRoot);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(xdgRoot, { recursive: true, force: true });
  });

  describe('self — the surface of the node the expression is attached to', () => {
    const SELF_SURFACE_UNTIL =
      'self.iterations >= int(self.needs.seed.output) && self.nodes.check.output == "pass"';

    const selfSurfaceWorkflow = (options: { until?: string; refineIf?: string } = {}): string => `
name: self-surface
nodes:
  - id: seed
    bash: 'echo -n 3 > "$HEIMDALL_OUTPUT"'
  - id: refine
    depends_on: [seed]
${indentBlock(options.refineIf === undefined ? '' : `if: '${options.refineIf}'`, 4)}
    loop:
      max_iterations: 9
      until: '${options.until ?? SELF_SURFACE_UNTIL}'
      nodes:
        - id: attempt
          bash: 'echo -n "round" > "$HEIMDALL_OUTPUT"'
        - id: check
          depends_on: [attempt]
          bash: 'echo -n "pass" > "$HEIMDALL_OUTPUT"'
      outputs:
        verdict: 'self.nodes.check.output'
        rounds: 'self.iterations'
        threshold: 'self.needs.seed.output'
  - id: report
    depends_on: [refine]
    bash: 'echo -n "verdict=\${{ self.needs.refine.output.verdict }} rounds=\${{ self.needs.refine.output.rounds }}" > "$HEIMDALL_OUTPUT"'
`;

    let run: RunOutcome;

    beforeAll(async () => {
      run = await runWorkflow(selfSurfaceWorkflow());
    });

    it('runs the body until its own counter, body snapshot and declared edge all agree', () => {
      expect(run.result.success).toBe(true);
      expect(outputsOf(run, 'attempt')).toHaveLength(3);
      expect(resultsOf(run, 'refine')[0]?.['iterations']).toBe(3);
    });

    it('resolves all three checkpoint values into the loop outputs map', () => {
      expect(loopOutputsOf(run, 'refine')).toEqual({
        verdict: 'pass',
        rounds: 3,
        threshold: '3',
      });
    });

    it('resolves a downstream read of the loop result through the same self.needs spelling', () => {
      expect(outputsOf(run, 'report')).toEqual(['verdict=pass rounds=3']);
    });

    it.each([
      ['nodes.check.output == "pass"', 'nodes'],
      ['needs.seed.output == "3"', 'needs'],
    ])('fails the loop when until reads %s — bare %s is not a root', async (until) => {
      const brokenRun = await runWorkflow(selfSurfaceWorkflow({ until }));

      expect(brokenRun.result.success).toBe(false);
      expect(failureTextFor(brokenRun, 'refine')).toContain('CEL evaluation failed');
      expect(resultsOf(brokenRun, 'refine')).toHaveLength(0);
      expect(startedIds(brokenRun)).not.toContain('report');
    });

    it('fails a loop whose if reads self.nodes — an entry site sees only self.needs', async () => {
      const brokenRun = await runWorkflow(
        selfSurfaceWorkflow({ refineIf: 'self.nodes.attempt.output == "round"' })
      );

      expect(brokenRun.result.success).toBe(false);
      expect(failureTextFor(brokenRun, 'refine')).toContain('CEL evaluation failed');
      expect(startedIds(brokenRun)).not.toContain('refine');
      expect(startedIds(brokenRun)).not.toContain('report');
    });
  });

  describe('scopes — enclosing scoped nodes addressed by id', () => {
    let run: RunOutcome;

    beforeAll(async () => {
      run = await runWorkflow(namedAncestorsWorkflow);
    });

    it('gives every body node the same index for each enclosing loop', () => {
      expect(run.result.success).toBe(true);
      expect(outputsOf(run, 'work')).toEqual(['c0r0', 'c0r1', 'c1r0', 'c1r1']);
    });

    it('reaches a dependency declared two scopes out through that ancestor needs map', () => {
      expect(outputsOf(run, 'seed_read')).toEqual([
        'seed=baseline',
        'seed=baseline',
        'seed=baseline',
        'seed=baseline',
      ]);
    });

    it('exposes prev as the previous body execution of the named loop, empty on its first', () => {
      expect(outputsOf(run, 'prev_read')).toEqual([
        'prev=none',
        'prev=c0r0',
        'prev=none',
        'prev=c1r0',
      ]);
    });

    it('carries the innermost result outward through each enclosing loop outputs map', () => {
      expect(outputsOf(run, 'retry')).toEqual([{ last: 'c0r1' }, { last: 'c1r1' }]);
      expect(resultsOf(run, 'ci')[0]?.['iterations']).toBe(2);
      expect(loopOutputsOf(run, 'ci')).toEqual({ last: 'c1r1' });
    });

    it.each(['scopes.loop.index', 'scopes.outer.loop.index', 'scopes.needs.seed'])(
      'fails a body node referencing %s — no ancestor carries that id',
      async (expression) => {
        const yaml = `
name: unnamed-ancestor
nodes:
  - id: seed
    bash: 'echo -n baseline > "$HEIMDALL_OUTPUT"'
  - id: ci
    depends_on: [seed]
    loop:
      max_iterations: 1
      nodes:
        - id: work
          bash: 'echo -n "\${{ ${expression} }}" > "$HEIMDALL_OUTPUT"'
`;

        const brokenRun = await runWorkflow(yaml);

        expect(brokenRun.result.success).toBe(false);
        expect(failureTextFor(brokenRun, 'work')).toContain('CEL evaluation failed');
        expect(resultsOf(brokenRun, 'work')).toHaveLength(0);
      }
    );
  });

  describe('loop checkpoints — outside their own scope', () => {
    const retryOutputs = `
last: 'self.nodes.work.output'
mine: 'self.iterations'
enclosing: 'scopes.ci.index'
`.trim();

    it('reads its own terminated-execution count and the current index of the enclosing loop', async () => {
      const run = await runWorkflow(checkpointVantageWorkflow(retryOutputs));

      expect(run.result.success).toBe(true);
      expect(outputsOf(run, 'retry')).toEqual([
        { last: 'done', mine: 2, enclosing: 0 },
        { last: 'done', mine: 2, enclosing: 1 },
      ]);
    });

    it.each([
      ["own: 'scopes.retry.index'", 'a loop never appears in its own scopes map'],
      ["own: 'self.index'", 'a checkpoint has no index'],
    ])('fails the loop when its outputs add %s — %s', async (badOutput) => {
      const run = await runWorkflow(checkpointVantageWorkflow(`${retryOutputs}\n${badOutput}`));

      expect(run.result.success).toBe(false);
      expect(failureTextFor(run, 'retry')).toContain('CEL evaluation failed');
      expect(resultsOf(run, 'retry')).toHaveLength(0);
    });

    it('fails a body node reading iterations off an enclosing loop — a body has an index', async () => {
      const yaml = `
name: wrong-phase-counter
nodes:
  - id: retry
    loop:
      max_iterations: 2
      nodes:
        - id: work
          bash: 'echo -n "\${{ scopes.retry.iterations }}" > "$HEIMDALL_OUTPUT"'
`;

      const run = await runWorkflow(yaml);

      expect(run.result.success).toBe(false);
      expect(failureTextFor(run, 'work')).toContain('CEL evaluation failed');
      expect(resultsOf(run, 'work')).toHaveLength(0);
    });
  });

  describe('refactor safety — wrapping and renaming', () => {
    it('preserves every reference in a node list wrapped in a new enclosing loop', async () => {
      const wrapped = `
name: named-ancestors-wrapped
nodes:
  - id: outermost
    loop:
      max_iterations: 1
      nodes:
${indentBlock(NAMED_ANCESTOR_NODES, 8)}
`;

      const run = await runWorkflow(wrapped);

      expect(run.result.success).toBe(true);
      expect(outputsOf(run, 'work')).toEqual(['c0r0', 'c0r1', 'c1r0', 'c1r1']);
      expect(outputsOf(run, 'prev_read')).toEqual([
        'prev=none',
        'prev=c0r0',
        'prev=none',
        'prev=c1r0',
      ]);
      expect(loopOutputsOf(run, 'ci')).toEqual({ last: 'c1r1' });
    });

    it('fails every reference to a renamed ancestor rather than retargeting them', async () => {
      const renamed = `
name: named-ancestors-renamed
nodes:
${indentBlock(NAMED_ANCESTOR_NODES.replace('- id: ci\n', '- id: ci_pipeline\n'), 2)}
`;

      const run = await runWorkflow(renamed);

      expect(run.result.success).toBe(false);
      expect(failureTextFor(run, 'work')).toContain('CEL evaluation failed');
      expect(resultsOf(run, 'work')).toHaveLength(0);
    });
  });

  describe('self.nodes — the latest body execution only', () => {
    const snapshotWorkflow = (maxIterations: number, conditionalOutput: string): string => `
name: snapshot-rule
nodes:
  - id: gated
    loop:
      max_iterations: ${maxIterations}
      nodes:
        - id: always
          bash: 'echo -n ran > "$HEIMDALL_OUTPUT"'
        - id: first_only
          if: 'scopes.gated.index == 0'
          bash: 'echo -n once > "$HEIMDALL_OUTPUT"'
      outputs:
        always_ran: 'self.nodes.always.output'
        conditional: '${conditionalOutput}'
`;

    const guardedConditional =
      'has(self.nodes.first_only) ? self.nodes.first_only.output : "absent"';

    it('drops a node skipped on the last execution instead of accumulating it', async () => {
      const run = await runWorkflow(snapshotWorkflow(3, guardedConditional));

      expect(run.result.success).toBe(true);
      expect(outputsOf(run, 'always')).toHaveLength(3);
      expect(loopOutputsOf(run, 'gated')).toEqual({ always_ran: 'ran', conditional: 'absent' });
    });

    it('holds the node when the only body execution ran it', async () => {
      const run = await runWorkflow(snapshotWorkflow(1, guardedConditional));

      expect(run.result.success).toBe(true);
      expect(loopOutputsOf(run, 'gated')).toEqual({ always_ran: 'ran', conditional: 'once' });
    });

    it('fails the loop at outputs when an entry absent from the snapshot is read unguarded', async () => {
      const run = await runWorkflow(snapshotWorkflow(3, 'self.nodes.first_only.output'));

      expect(run.result.success).toBe(false);
      expect(failureTextFor(run, 'gated')).toContain('CEL evaluation failed');
      expect(resultsOf(run, 'gated')).toHaveLength(0);
    });

    const zeroIterationWorkflow = (alwaysRanOutput: string): string => `
name: zero-iterations
nodes:
  - id: gated
    loop:
      max_iterations: 3
      while: 'false'
      nodes:
        - id: always
          bash: 'echo -n ran > "$HEIMDALL_OUTPUT"'
      outputs:
        count: 'self.iterations'
        always_ran: '${alwaysRanOutput}'
`;

    it('binds an empty body map and a zero count when the body never runs', async () => {
      const run = await runWorkflow(
        zeroIterationWorkflow('has(self.nodes.always) ? self.nodes.always.output : "never"')
      );

      expect(run.result.success).toBe(true);
      expect(resultsOf(run, 'always')).toHaveLength(0);
      expect(resultsOf(run, 'gated')[0]?.['iterations']).toBe(0);
      expect(loopOutputsOf(run, 'gated')).toEqual({ count: 0, always_ran: 'never' });
    });

    it('fails the loop when the empty body map is read unguarded', async () => {
      const run = await runWorkflow(zeroIterationWorkflow('self.nodes.always.output'));

      expect(run.result.success).toBe(false);
      expect(failureTextFor(run, 'gated')).toContain('CEL evaluation failed');
      expect(resultsOf(run, 'gated')).toHaveLength(0);
    });

    it('counts a body execution ended by break and passes its partial snapshot to outputs', async () => {
      const yaml = `
name: snapshot-break
nodes:
  - id: gated
    loop:
      max_iterations: 5
      nodes:
        - id: always
          bash: 'echo -n ran > "$HEIMDALL_OUTPUT"'
        - id: stop
          depends_on: [always]
          if: 'scopes.gated.index >= 1'
          break: true
        - id: after
          depends_on: [stop]
          bash: 'echo -n after > "$HEIMDALL_OUTPUT"'
      outputs:
        count: 'self.iterations'
        always_ran: 'self.nodes.always.output'
        after_seen: 'has(self.nodes.after)'
`;

      const run = await runWorkflow(yaml);

      expect(run.result.success).toBe(true);
      expect(outputsOf(run, 'always')).toHaveLength(2);
      expect(outputsOf(run, 'after')).toEqual(['after']);
      expect(resultsOf(run, 'gated')[0]?.['iterations']).toBe(2);
      expect(loopOutputsOf(run, 'gated')).toEqual({
        count: 2,
        always_ran: 'ran',
        after_seen: false,
      });
    });
  });

  describe('self.needs — declared edges only', () => {
    const undeclaredReadWorkflow = (dependsOn: string): string => `
name: undeclared-read
nodes:
  - id: slow
    bash: 'sleep 1; echo -n done > "$HEIMDALL_OUTPUT"'
  - id: peeker
${indentBlock(dependsOn, 4)}
    bash: 'echo -n "\${{ self.needs.slow.output }}" > "$HEIMDALL_OUTPUT"'
`;

    it('fails a node reading a sibling it does not depend on', async () => {
      const run = await runWorkflow(undeclaredReadWorkflow(''));

      expect(run.result.success).toBe(false);
      expect(failureTextFor(run, 'peeker')).toContain('CEL evaluation failed');
      expect(resultsOf(run, 'peeker')).toHaveLength(0);
    });

    it('resolves the same read once the dependency is declared', async () => {
      const run = await runWorkflow(undeclaredReadWorkflow('depends_on: [slow]'));

      expect(run.result.success).toBe(true);
      expect(outputsOf(run, 'peeker')).toEqual(['done']);
    });

    it('fails a read of a completed transitive ancestor that is not a declared edge', async () => {
      const yaml = `
name: transitive-read
nodes:
  - id: seed
    bash: 'echo -n baseline > "$HEIMDALL_OUTPUT"'
  - id: gate
    depends_on: [seed]
    bash: 'true'
  - id: peeker
    depends_on: [gate]
    bash: 'echo -n "\${{ self.needs.seed.output }}" > "$HEIMDALL_OUTPUT"'
`;

      const run = await runWorkflow(yaml);

      // seed completed before peeker ran, so nothing but the declared-edge filter can explain
      // the failure.
      expect(outputsOf(run, 'seed')).toEqual(['baseline']);
      expect(run.result.success).toBe(false);
      expect(failureTextFor(run, 'peeker')).toContain('CEL evaluation failed');
      expect(resultsOf(run, 'peeker')).toHaveLength(0);
    });
  });
});
