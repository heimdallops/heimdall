import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseAgent } from '../../../../../src/core/platform/claude/parse-agent.ts';
import { PlatformError } from '../../../../../src/core/platform/errors.ts';

describe('parseAgent', () => {
  describe('frontmatter + body', () => {
    it('returns body as prompt and frontmatter fields as options', () => {
      const content = `---
model: claude-opus-4-5
system_prompt: You are helpful.
---
Do the thing.`;

      const result = parseAgent(content);

      expect(result.prompt).toBe('Do the thing.');
      expect(result.options.model).toBe('claude-opus-4-5');
      expect(result.options.system_prompt).toBe('You are helpful.');
    });

    it('trims leading/trailing whitespace from the body', () => {
      const content = `---
model: sonnet
---

  trimmed content  `;

      const result = parseAgent(content);

      expect(result.prompt).toBe('trimmed content');
    });
  });

  describe('no frontmatter', () => {
    it('returns the full content as prompt and empty options', () => {
      const content = 'Just a plain prompt with no frontmatter.';

      const result = parseAgent(content);

      expect(result.prompt).toBe('Just a plain prompt with no frontmatter.');
      expect(result.options).toEqual({});
    });

    it('returns empty prompt and empty options when input starts with "---" but has no closing delimiter', () => {
      // gray-matter treats "---\nsome text" (no closing ---) as having no YAML block,
      // returning the text as non-object data and an empty content string.
      const content = '---\nPrompt text here.';

      const result = parseAgent(content);

      expect(result.prompt).toBe('');
      expect(result.options).toEqual({});
    });
  });

  describe('tools alias', () => {
    it('maps tools in frontmatter to allowed_tools in options', () => {
      const content = `---
tools:
  - Read
  - Write
---
Do something.`;

      const result = parseAgent(content);

      expect(result.options.allowed_tools).toEqual(['Read', 'Write']);
      expect((result.options as Record<string, unknown>)['tools']).toBeUndefined();
    });
  });

  describe('unknown frontmatter keys', () => {
    it('silently drops unknown keys and does not include them in options', () => {
      const content = `---
model: sonnet
unknown_key: some_value
another_unknown: 42
---
Prompt body.`;

      const result = parseAgent(content);

      expect(result.options.model).toBe('sonnet');
      expect((result.options as Record<string, unknown>)['unknown_key']).toBeUndefined();
      expect((result.options as Record<string, unknown>)['another_unknown']).toBeUndefined();
    });
  });

  describe('invalid values for known keys', () => {
    it('throws PlatformError when reasoning_effort has an invalid value', () => {
      const content = `---
reasoning_effort: invalid
---
Prompt.`;

      expect(() => parseAgent(content)).toThrow(PlatformError);
    });

    it('throws PlatformError when max_budget_usd is a negative number', () => {
      const content = `---
max_budget_usd: -5
---
Prompt.`;

      expect(() => parseAgent(content)).toThrow(PlatformError);
    });

    it('throws PlatformError with code PLATFORM_ERROR', () => {
      const content = `---
reasoning_effort: bad_value
---
Prompt.`;

      let thrown: unknown;
      try {
        parseAgent(content);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(PlatformError);
      expect((thrown as PlatformError).code).toBe('PLATFORM_ERROR');
    });
  });

  describe('empty file', () => {
    it('returns empty prompt and empty options for an empty string', () => {
      const result = parseAgent('');

      expect(result.prompt).toBe('');
      expect(result.options).toEqual({});
    });
  });

  describe('valid option values', () => {
    it('accepts all valid reasoning_effort values', () => {
      for (const effort of ['low', 'medium', 'high', 'max'] as const) {
        const content = `---\nreasoning_effort: ${effort}\n---\nPrompt.`;
        expect(() => parseAgent(content)).not.toThrow();
        expect(parseAgent(content).options.reasoning_effort).toBe(effort);
      }
    });

    it('accepts allowed_tools as an array', () => {
      const content = `---
allowed_tools:
  - Bash
  - Read
---
Prompt.`;

      const result = parseAgent(content);
      expect(result.options.allowed_tools).toEqual(['Bash', 'Read']);
    });
  });

  describe('integration: real agent files in .claude/agents/', () => {
    it('parses all agent files in .claude/agents/ without throwing', async () => {
      const agentsDir = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '../../../../../.claude/agents'
      );
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(agentsDir);

      for (const file of files.filter((f) => f.endsWith('.md'))) {
        const content = await readFile(path.join(agentsDir, file), 'utf8');
        expect(() => parseAgent(content), `parseAgent should not throw for ${file}`).not.toThrow();
      }
    });
  });
});
