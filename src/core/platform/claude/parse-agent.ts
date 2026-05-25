import matter from 'gray-matter';

import { PlatformError } from '../errors.ts';
import type { ClaudeOptions } from './options.ts';
import { claudeOptionsSchema } from './options.ts';

const FIELD_ALIASES: Record<string, string> = {
  tools: 'allowed_tools',
};

const ARRAY_COERCE_KEYS = new Set(['allowed_tools', 'denied_tools']);

export const parseAgent = (content: string): { prompt: string; options: ClaudeOptions } => {
  const { data: rawFrontmatter, content: body } = matter(content);

  const aliased: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rawFrontmatter)) {
    const canonical = FIELD_ALIASES[key] ?? key;
    aliased[canonical] = value;
  }

  for (const key of ARRAY_COERCE_KEYS) {
    if (typeof aliased[key] === 'string') {
      aliased[key] = aliased[key]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  const result = claudeOptionsSchema.partial().safeParse(aliased);

  if (!result.success) {
    const [issue] = result.error.issues;
    const fieldPath = issue?.path.join('.') ?? 'unknown';
    throw new PlatformError(
      'PLATFORM_ERROR',
      `Invalid agent frontmatter at '${fieldPath}': ${issue?.code ?? 'validation error'}`
    );
  }

  return {
    prompt: body.trim(),
    options: result.data,
  };
};
