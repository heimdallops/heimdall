import matter from 'gray-matter';
import { ZodError } from 'zod';

import { PlatformError } from '../errors.ts';
import { type ClaudeOptions, claudeOptionsSchema } from './options.ts';

// "tools" is a shorter alias accepted in agent frontmatter; normalize it before schema validation
const applyAliases = (raw: Record<string, unknown>): Record<string, unknown> => {
  const result = { ...raw };

  if ('tools' in result) {
    const rawTools = result['tools'];
    result['allowed_tools'] =
      typeof rawTools === 'string'
        ? rawTools
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : rawTools;
    delete result['tools'];
  }

  return result;
};

export const parseAgent = (content: string): { prompt: string; options: ClaudeOptions } => {
  const parsed = matter(content, {
    language: 'yaml',
    engines: {
      javascript: {
        parse: () => {
          throw new PlatformError('JavaScript frontmatter is not allowed', 'PLATFORM_ERROR');
        },
      },
    },
  });
  const rawData = parsed.data;

  if (Object.keys(rawData).length === 0) {
    return { prompt: parsed.content.trim(), options: {} };
  }

  const withAliases = applyAliases(rawData);

  try {
    const options = claudeOptionsSchema.parse(withAliases);

    return { prompt: parsed.content.trim(), options };
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      const details = err.issues.map((i) => i.message).join(', ');

      throw new PlatformError(`Invalid option: ${details}`, 'PLATFORM_ERROR', err);
    }

    throw err;
  }
};
