import matter from 'gray-matter';

import { PlatformError } from '../errors.ts';
import type { ClaudeOptions } from './options.ts';
import { claudeOptionsSchema } from './options.ts';

const FIELD_ALIASES: Record<string, string> = {
  tools: 'allowed_tools',
};

export const parseAgent = (content: string): { prompt: string; options: ClaudeOptions } => {
  const { data: rawFrontmatter, content: body } = matter(content);

  const aliased: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rawFrontmatter)) {
    const canonical = FIELD_ALIASES[key] ?? key;
    aliased[canonical] = value;
  }

  const result = claudeOptionsSchema.partial().safeParse(aliased);

  if (!result.success) {
    const [issue] = result.error.issues;
    throw new PlatformError(
      'PLATFORM_ERROR',
      `Invalid agent frontmatter: ${issue?.path.join('.') ?? 'unknown'}: ${issue?.message ?? 'validation error'}`
    );
  }

  return {
    prompt: body.trim(),
    options: result.data,
  };
};
