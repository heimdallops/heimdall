import '../../../src/core/engine/nodes/agentic.ts';
import '../../../src/core/engine/nodes/loop.ts';

import { describe, expect, it } from 'vitest';

import type { PlatformAdapter, PlatformStream } from '../../../src/core/engine/nodes/base.ts';
import { Workflow } from '../../../src/core/engine/workflow.ts';

interface AdapterCall {
  readonly prompt: string;
  readonly resumedFrom: string | undefined;
  readonly sessionId: string;
}

// Every run reports a session id of its own, as a platform that forks on resume does.
class ForkingAdapter implements PlatformAdapter {
  public readonly calls: AdapterCall[] = [];

  public run(
    prompt: string,
    _options: Record<string, unknown>,
    resumedFrom?: string
  ): PlatformStream {
    const sessionId = `session-${this.calls.length + 1}`;
    this.calls.push({ prompt, resumedFrom, sessionId });

    const stream: PlatformStream = {
      on: (event, handler) => {
        if (event === 'done') {
          setImmediate(handler);
        }

        return stream;
      },
      cancel: () => undefined,
      sessionId: () => Promise.resolve(sessionId),
    };

    return stream;
  }
}

const runWorkflow = async (yaml: string): Promise<ForkingAdapter> => {
  const adapter = new ForkingAdapter();
  const workflow = await Workflow.from(yaml);
  const result = await workflow.run({
    inputs: {},
    adapterFactory: () => Promise.resolve(adapter),
  });

  expect(result.success).toBe(true);

  return adapter;
};

const callFor = (adapter: ForkingAdapter, prompt: string): AdapterCall => {
  const call = adapter.calls.find((candidate) => candidate.prompt === prompt);
  if (call === undefined) {
    throw new Error(`No agent run received the prompt '${prompt}'`);
  }

  return call;
};

// `${{ … }}` is written `\${{ … }}` throughout so the JS template-literal parser does not read
// `${` as an interpolation opener; the workflow text itself carries the normal spelling.
describe('agent session chaining', () => {
  it('continues from the session of the dependency a node names', async () => {
    const adapter = await runWorkflow(`
name: chain
nodes:
  - id: plan
    prompt: plan
  - id: implement
    depends_on: [plan]
    session: \${{ self.needs.plan.session_id }}
    prompt: implement
`);

    expect(callFor(adapter, 'plan').resumedFrom).toBeUndefined();
    expect(callFor(adapter, 'implement').resumedFrom).toBe(callFor(adapter, 'plan').sessionId);
  });

  it('starts a fresh session for a dependent that names no session', async () => {
    const adapter = await runWorkflow(`
name: unchained
nodes:
  - id: plan
    prompt: plan
  - id: implement
    depends_on: [plan]
    prompt: implement
`);

    expect(callFor(adapter, 'implement').resumedFrom).toBeUndefined();
  });

  it('lets parallel nodes continue from one session and a later node pick either branch', async () => {
    const adapter = await runWorkflow(`
name: fan
nodes:
  - id: plan
    prompt: plan
  - id: frontend
    depends_on: [plan]
    session: \${{ self.needs.plan.session_id }}
    prompt: frontend
  - id: backend
    depends_on: [plan]
    session: \${{ self.needs.plan.session_id }}
    prompt: backend
  - id: review
    depends_on: [frontend, backend]
    session: \${{ self.needs.backend.session_id }}
    prompt: review
`);

    const planSession = callFor(adapter, 'plan').sessionId;

    expect(callFor(adapter, 'frontend').resumedFrom).toBe(planSession);
    expect(callFor(adapter, 'backend').resumedFrom).toBe(planSession);
    expect(callFor(adapter, 'review').resumedFrom).toBe(callFor(adapter, 'backend').sessionId);
  });

  it('continues a loop body from its own previous iteration', async () => {
    const adapter = await runWorkflow(`
name: looped
nodes:
  - id: refine
    loop:
      max_iterations: 3
      nodes:
        - id: step
          session: '\${{ has(scopes.refine.prev.step) ? scopes.refine.prev.step.session_id : "" }}'
          prompt: step
`);

    const steps = adapter.calls.filter((call) => call.prompt === 'step');

    expect(steps.map((call) => call.resumedFrom)).toEqual([
      undefined,
      steps[0]!.sessionId,
      steps[1]!.sessionId,
    ]);
  });
});
