import { z } from 'zod';

export const claudeOptionsSchema = z
  .object({
    model: z.string().optional(),
    agent: z.string().optional(),
    reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    allowed_tools: z.array(z.string()).optional(),
    disallowed_tools: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    max_budget_usd: z.number().min(0).optional(),
    system_prompt: z.string().optional(),
    sandbox: z.record(z.string(), z.unknown()).optional(),
  })
  .strip();

export type ClaudeOptions = z.infer<typeof claudeOptionsSchema>;
