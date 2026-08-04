import { z } from 'zod';

import { platformSchema } from '../platform/index.ts';

export const RetryPolicySchema = z.object({
  max_attempts: z.number().min(0).optional(),
  initial_delay_ms: z.number().min(0).optional(),
  max_delay_ms: z.number().min(0).optional(),
});

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const InputDeclarationSchema = z
  .object({
    type: z.enum(['string', 'number', 'integer', 'boolean']),
    description: z.string().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.default === undefined) {
      return;
    }

    const expectedJsType = data.type === 'integer' ? 'number' : data.type;

    if (typeof data.default !== expectedJsType) {
      ctx.addIssue({
        code: 'invalid_type',
        path: ['default'],
        expected: data.type === 'integer' ? 'int' : data.type,
        input: data.default,
      });
    }

    if (
      data.type === 'integer' &&
      typeof data.default === 'number' &&
      !Number.isInteger(data.default)
    ) {
      ctx.addIssue({
        code: 'invalid_type',
        path: ['default'],
        expected: 'int',
        input: data.default,
        message: 'default must be an integer',
      });
    }
  });

export type InputDeclaration = z.infer<typeof InputDeclarationSchema>;

export const WorkspaceConfigSchema = z.object({
  worktree: z.boolean().optional(),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

const idPattern = /^[a-zA-Z0-9_]+$/;

const BaseNodeSchema = z.object({
  id: z.string().regex(idPattern, 'Node id must match ^[a-zA-Z0-9_]+$'),
  name: z.string().optional(),
  depends_on: z
    .array(z.string().regex(idPattern, 'depends_on must be an array of valid node ids'))
    .optional(),
  if: z.string().optional(),
  timeout: z.number().min(0).optional(),
  retries: RetryPolicySchema.optional(),
});

export const BashNodeSchema = BaseNodeSchema.extend({
  bash: z.string(),
  env: z.record(z.string(), z.string()).optional(),
  output_format: z.enum(['text', 'json']).optional(),
});

export const AgenticBaseNodeSchema = BaseNodeSchema.extend({
  platform: platformSchema.optional(),
  platform_options: z.record(z.string(), z.unknown()).optional(),
  context: z.enum(['clean', 'shared']).optional(),
  output_format: z.record(z.string(), z.unknown()).optional(),
});

export const AgentNodeSchema = AgenticBaseNodeSchema.extend({
  agent: z.string().min(1, 'agent must not be empty'),
  instructions: z.string().optional(),
});

export const PromptNodeSchema = AgenticBaseNodeSchema.extend({
  prompt: z.string(),
});

export const PromptFileNodeSchema = AgenticBaseNodeSchema.extend({
  prompt_file: z.string(),
});

export const ApprovalNodeSchema = BaseNodeSchema.extend({
  approval: z.object({
    message: z.string(),
    exit_on_no: z.boolean().default(false),
    enable_feedback: z.boolean().default(false),
  }),
});

export const ExitNodeSchema = BaseNodeSchema.extend({
  exit: z.object({
    reason: z.string().optional(),
    failure: z.boolean().optional(),
  }),
});

export const BreakNodeSchema = BaseNodeSchema.extend({
  break: z.unknown(),
}).superRefine((data, ctx) => {
  if (!('break' in data)) {
    ctx.addIssue({ code: 'custom', path: ['break'], message: "'break' field is required" });
  }
});

// Any node: `id` is the only universally-required field. Type-specific fields are validated
// by each node's own schema (run via the registry's parseNode()), not here — so the registry
// is the single place that recognizes node types, rather than a closed union this schema
// would have to enumerate. Loop bodies are likewise validated by LoopNode.validate(), not
// recursively here.
export const NodeSchema = z
  .object({ id: z.string().regex(idPattern, 'Node id must match ^[a-zA-Z0-9_]+$') })
  .loose();

export type Node = z.infer<typeof NodeSchema>;

export type LoopNode = z.infer<typeof BaseNodeSchema> & {
  loop: {
    until?: string | undefined;
    while?: string | undefined;
    max_iterations?: number | undefined;
    nodes: Node[];
    outputs?: Record<string, string> | undefined;
  };
};

export const LoopNodeSchema = BaseNodeSchema.extend({
  loop: z
    .object({
      // An empty expression is normalized to unset so it cannot satisfy the bound refine below
      // and produce a loop that LoopNode then runs unconditionally.
      until: z
        .string()
        .optional()
        .transform((value) => (value === '' ? undefined : value)),
      while: z
        .string()
        .optional()
        .transform((value) => (value === '' ? undefined : value)),
      max_iterations: z.number().int().min(1).optional(),
      nodes: z.array(NodeSchema).min(1),
      outputs: z.record(z.string(), z.string()).optional(),
    })
    .refine(
      (data) =>
        data.until !== undefined || data.while !== undefined || data.max_iterations !== undefined,
      { message: 'loop must specify at least one of: until, while, max_iterations' }
    )
    .refine((data) => !(data.until !== undefined && data.while !== undefined), {
      message: 'loop cannot specify both until and while',
    }),
});

export type BashNode = z.infer<typeof BashNodeSchema>;
export type AgenticBaseNode = z.infer<typeof AgenticBaseNodeSchema>;
export type AgentNode = z.infer<typeof AgentNodeSchema>;
export type PromptNode = z.infer<typeof PromptNodeSchema>;
export type PromptFileNode = z.infer<typeof PromptFileNodeSchema>;
export type ApprovalNode = z.infer<typeof ApprovalNodeSchema>;
export type ExitNode = z.infer<typeof ExitNodeSchema>;
export type BreakNode = z.infer<typeof BreakNodeSchema>;

export const WorkflowDefinitionSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  description: z.string().optional(),
  platform: platformSchema.optional(),
  platform_options: z.record(z.string(), z.unknown()).optional(),
  inputs: z.record(z.string(), InputDeclarationSchema).optional(),
  vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  workspace: WorkspaceConfigSchema.optional(),
  nodes: z.array(NodeSchema).min(1),
});

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
