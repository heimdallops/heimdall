import { describe, expect, it } from 'vitest';

import {
  ApprovalNodeSchema,
  InputDeclarationSchema,
  LoopNodeSchema,
  NodeSchema,
  WorkflowDefinitionSchema,
} from '../../../../src/core/engine/schema.ts';

const baseWorkflow = {
  name: 'My Workflow',
  nodes: [{ id: 'step1', bash: 'echo hello' }],
};

describe('WorkflowDefinitionSchema', () => {
  describe('valid workflows', () => {
    it('accepts a minimal workflow with name and one node', () => {
      const result = WorkflowDefinitionSchema.safeParse(baseWorkflow);

      expect(result.success).toBe(true);
    });

    it('accepts optional top-level fields', () => {
      const result = WorkflowDefinitionSchema.safeParse({
        ...baseWorkflow,
        version: '1.0.0',
        description: 'A test workflow',
        platform: 'claude',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('required fields', () => {
    it('rejects when name is absent', () => {
      const result = WorkflowDefinitionSchema.safeParse({ nodes: baseWorkflow.nodes });

      expect(result.success).toBe(false);
    });

    it('rejects when name is an empty string', () => {
      const result = WorkflowDefinitionSchema.safeParse({ ...baseWorkflow, name: '' });

      expect(result.success).toBe(false);
    });

    it('rejects when nodes is absent', () => {
      const result = WorkflowDefinitionSchema.safeParse({ name: 'My Workflow' });

      expect(result.success).toBe(false);
    });

    it('rejects when nodes array is empty', () => {
      const result = WorkflowDefinitionSchema.safeParse({ ...baseWorkflow, nodes: [] });

      expect(result.success).toBe(false);
    });
  });

  describe('node id validation', () => {
    const node = (id: string): { id: string; bash: string } => ({ id, bash: 'echo hi' });

    it.each([
      ['a hyphen', 'my-node'],
      ['a space', 'my node'],
      ['a dot', 'my.node'],
      ['an empty string', ''],
    ])('rejects a node id containing %s', (_label, id) => {
      const result = WorkflowDefinitionSchema.safeParse({
        ...baseWorkflow,
        nodes: [node(id)],
      });

      expect(result.success).toBe(false);
    });

    it.each([
      ['only letters', 'stepone'],
      ['letters, digits, and underscores', 'step_1_final'],
      ['a leading underscore', '_internal'],
    ])('accepts a node id with %s', (_label, id) => {
      const result = WorkflowDefinitionSchema.safeParse({
        ...baseWorkflow,
        nodes: [node(id)],
      });

      expect(result.success).toBe(true);
    });
  });

  describe('node types', () => {
    const workflow = (nodeFields: object): object => ({
      ...baseWorkflow,
      nodes: [{ id: 'n1', ...nodeFields }],
    });

    it.each([
      ['bash', { bash: 'echo hi' }],
      ['agent', { agent: 'my-agent' }],
      ['prompt', { prompt: 'Do something' }],
      ['prompt_file', { prompt_file: './prompt.md' }],
      ['approval', { approval: { message: 'Approve?' } }],
      ['exit', { exit: {} }],
      ['break', { break: true }],
      [
        'loop with max_iterations',
        { loop: { max_iterations: 3, nodes: [{ id: 'inner', bash: 'echo loop' }] } },
      ],
      [
        'loop with until',
        { loop: { until: 'scope.iteration == 3', nodes: [{ id: 'inner', bash: 'echo loop' }] } },
      ],
    ])('accepts a %s node', (_label, nodeFields) => {
      const result = WorkflowDefinitionSchema.safeParse(workflow(nodeFields));

      expect(result.success).toBe(true);
    });
  });

  describe('inputs', () => {
    it('parses declared inputs and preserves their fields', () => {
      const result = WorkflowDefinitionSchema.safeParse({
        ...baseWorkflow,
        inputs: {
          env: { type: 'string', description: 'Environment name', default: 'production' },
          count: { type: 'integer' },
        },
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(result.data.inputs?.['env']).toEqual({
        type: 'string',
        description: 'Environment name',
        default: 'production',
      });
      expect(result.data.inputs?.['count']).toEqual({ type: 'integer' });
    });
  });
});

describe('NodeSchema', () => {
  it('accepts any extra fields alongside a valid id (passthrough)', () => {
    const result = NodeSchema.safeParse({
      id: 'my_node',
      unknown_field: 'hello',
      nested: { x: 1 },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    // passthrough: extra keys must be preserved in the parsed output
    expect(result.data['unknown_field']).toBe('hello');
    expect(result.data['nested']).toEqual({ x: 1 });
  });

  it('rejects a node missing the id field entirely', () => {
    const result = NodeSchema.safeParse({ bash: 'echo hi' });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    const paths = result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('id');
  });

  it('rejects a node whose id contains invalid characters', () => {
    const result = NodeSchema.safeParse({ id: 'bad-id', bash: 'echo hi' });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    const issue = result.error.issues.find((i) => i.path.includes('id'));
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/Node id must match/);
  });
});

describe('LoopNodeSchema', () => {
  const baseLoop = (loop: object): { id: string; loop: object } => ({
    id: 'loop1',
    loop,
  });

  it('rejects a loop node with neither until nor max_iterations', () => {
    const result = LoopNodeSchema.safeParse(
      baseLoop({ nodes: [{ id: 'inner', bash: 'echo loop' }] })
    );

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    const messages = result.error.issues.map((i) => i.message);
    expect(messages.some((m) => m.includes('until') || m.includes('max_iterations'))).toBe(true);
  });

  it('rejects a loop node with an empty inner nodes array', () => {
    const result = LoopNodeSchema.safeParse(baseLoop({ max_iterations: 3, nodes: [] }));

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    const issue = result.error.issues.find((i) => i.path.includes('nodes'));
    expect(issue).toBeDefined();
  });

  it('accepts a loop node with max_iterations and at least one inner node', () => {
    const result = LoopNodeSchema.safeParse(
      baseLoop({ max_iterations: 3, nodes: [{ id: 'inner', bash: 'echo loop' }] })
    );

    expect(result.success).toBe(true);
  });

  it('accepts a loop node with until and at least one inner node', () => {
    const result = LoopNodeSchema.safeParse(
      baseLoop({
        until: 'scope.iteration == 3',
        nodes: [{ id: 'inner', bash: 'echo loop' }],
      })
    );

    expect(result.success).toBe(true);
  });
});

describe('ApprovalNodeSchema', () => {
  it('rejects an approval node missing approval.message', () => {
    const result = ApprovalNodeSchema.safeParse({ id: 'a1', approval: { exit_on_no: true } });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    const issue = result.error.issues.find((i) => i.path.includes('message'));
    expect(issue).toBeDefined();
  });

  it('accepts an approval node with only the required message field', () => {
    const result = ApprovalNodeSchema.safeParse({ id: 'a1', approval: { message: 'Approve?' } });

    expect(result.success).toBe(true);
  });
});

describe('InputDeclarationSchema', () => {
  describe('type validation', () => {
    it.each(['string', 'number', 'integer', 'boolean'] as const)('accepts type %s', (type) => {
      const result = InputDeclarationSchema.safeParse({ type });

      expect(result.success).toBe(true);
    });

    it('rejects an unrecognised type', () => {
      const result = InputDeclarationSchema.safeParse({ type: 'object' });

      expect(result.success).toBe(false);
    });
  });

  describe('default type matching', () => {
    it('accepts a string default for type string', () => {
      const result = InputDeclarationSchema.safeParse({ type: 'string', default: 'hello' });

      expect(result.success).toBe(true);
    });

    it('accepts a number default for type number', () => {
      const result = InputDeclarationSchema.safeParse({ type: 'number', default: 3.14 });

      expect(result.success).toBe(true);
    });

    it('accepts an integer default for type integer', () => {
      const result = InputDeclarationSchema.safeParse({ type: 'integer', default: 42 });

      expect(result.success).toBe(true);
    });

    it('accepts a boolean default for type boolean', () => {
      const result = InputDeclarationSchema.safeParse({ type: 'boolean', default: false });

      expect(result.success).toBe(true);
    });

    it('rejects a non-integer number default for type integer', () => {
      const result = InputDeclarationSchema.safeParse({ type: 'integer', default: 1.5 });

      expect(result.success).toBe(false);
    });

    it('rejects a mismatched default type', () => {
      const result = InputDeclarationSchema.safeParse({ type: 'boolean', default: 42 });

      expect(result.success).toBe(false);
    });
  });
});
