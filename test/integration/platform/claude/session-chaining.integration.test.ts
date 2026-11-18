import '../../../../src/core/engine/nodes/agentic.ts';
import '../../../../src/core/engine/nodes/loop.ts';

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { NodeResult } from '../../../../src/core/engine/emitter.ts';
import { Workflow } from '../../../../src/core/engine/workflow.ts';
import { recordEvents, resultOf as completedResult } from '../../../unit/core/engine/_events.ts';

// The SDK spawns a bundled Claude Code CLI binary that accepts ANTHROPIC_API_KEY from the
// environment or the developer's existing Claude Code CLI OAuth credentials (~/.claude/).
const isClaudeAvailable = async (): Promise<boolean> => {
  if (process.env['ANTHROPIC_API_KEY']) {
    return true;
  }

  try {
    await execa('which', ['claude']);

    return true;
  } catch {
    return false;
  }
};

const claudeAvailable = await isClaudeAvailable();

const RECALL = 'Reply with only the secret words I have told you, or UNKNOWN if there are none.';

// `${{ … }}` is written `\${{ … }}` throughout so the JS template-literal parser does not read
// `${` as an interpolation opener; the workflow text itself carries the normal spelling.
const BRANCHING_WORKFLOW = `
name: session-chaining
nodes:
  - id: plan
    prompt: 'My secret word is: heron. Reply with only: OK'
  - id: chained
    depends_on: [plan]
    session: \${{ self.needs.plan.session_id }}
    prompt: '${RECALL}'
  - id: unchained
    depends_on: [plan]
    prompt: '${RECALL}'
  - id: left
    depends_on: [plan]
    session: \${{ self.needs.plan.session_id }}
    prompt: 'My second secret word is: walnut. Reply with only: OK'
  - id: right
    depends_on: [plan]
    session: \${{ self.needs.plan.session_id }}
    prompt: 'My second secret word is: copper. Reply with only: OK'
  - id: review
    depends_on: [left, right]
    session: \${{ self.needs.right.session_id }}
    prompt: '${RECALL}'
`;

const LOOP_WORKFLOW = `
name: session-chaining-loop
nodes:
  - id: refine
    loop:
      max_iterations: 3
      nodes:
        - id: step
          session: '\${{ has(scopes.refine.prev.step) ? scopes.refine.prev.step.session_id : "" }}'
          prompt: 'Secret word number \${{ scopes.refine.index }} is: word\${{ scopes.refine.index }}. ${RECALL}'
`;

describe('agent session chaining against Claude', () => {
  let tempDir: string;

  // One entry per completion, in order, so a node inside a loop appears once per iteration.
  const runWorkflow = async (yaml: string): Promise<Map<string, NodeResult[]>> => {
    const workflow = await Workflow.from(yaml);
    const recorder = recordEvents();
    const results = new Map<string, NodeResult[]>();
    recorder.on('node.completed', (event) => {
      results.set(event.node.id, [...(results.get(event.node.id) ?? []), completedResult(event)]);
    });

    const outcome = await workflow.run({ inputs: {}, onEvent: recorder.onEvent, cwd: tempDir });

    expect(outcome.success).toBe(true);

    return results;
  };

  const outputOf = (result: NodeResult | undefined): string =>
    String(result?.['output']).toLowerCase();

  beforeAll(async () => {
    tempDir = await mkdtemp(join(os.tmpdir(), 'heimdall-session-chaining-'));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('across dependencies', () => {
    let results: Map<string, NodeResult[]>;

    const resultOf = (nodeId: string): NodeResult | undefined => results.get(nodeId)?.[0];

    beforeAll(async () => {
      if (claudeAvailable) {
        results = await runWorkflow(BRANCHING_WORKFLOW);
      }
    }, 180_000);

    it.skipIf(!claudeAvailable)('a node that names a session recalls its conversation', () => {
      expect(outputOf(resultOf('chained'))).toContain('heron');
    });

    it.skipIf(!claudeAvailable)('a dependent that names no session starts without it', () => {
      expect(outputOf(resultOf('unchained'))).not.toContain('heron');
    });

    it.skipIf(!claudeAvailable)('every run reports a session id of its own', () => {
      const sessionIds = ['plan', 'chained', 'left', 'right', 'review'].map(
        (nodeId) => resultOf(nodeId)?.['session_id']
      );

      expect(sessionIds.every((id) => typeof id === 'string' && id !== '')).toBe(true);
      expect(new Set(sessionIds).size).toBe(sessionIds.length);
    });

    it.skipIf(!claudeAvailable)(
      'a node after parallel branches continues only the branch it names',
      () => {
        const review = outputOf(resultOf('review'));

        expect(review).toContain('heron');
        expect(review).toContain('copper');
        expect(review).not.toContain('walnut');
      }
    );
  });

  it.skipIf(!claudeAvailable)(
    'a loop body continues from its own previous iteration',
    async () => {
      const results = await runWorkflow(LOOP_WORKFLOW);
      const steps = results.get('step') ?? [];

      expect(steps).toHaveLength(3);

      const lastOutput = outputOf(steps[2]);

      expect(lastOutput).toContain('word0');
      expect(lastOutput).toContain('word1');
      expect(lastOutput).toContain('word2');
    },
    180_000
  );
});
