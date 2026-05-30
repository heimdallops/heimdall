import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ClaudeCodeAdapter } from '../../../../../src/core/platform/claude/adapter.ts';

describe('parseAgent', () => {
  describe('frontmatter + body', () => {
    it('returns body as prompt and frontmatter fields as options', () => {
      const content = `---
model: claude-opus-4-5
---

You are a helpful assistant.`;

      const { prompt, options } = new ClaudeCodeAdapter().parseAgent(content);

      expect(prompt).toBe('You are a helpful assistant.');
      expect(options.model).toBe('claude-opus-4-5');
    });

    it('trims leading and trailing whitespace from the body', () => {
      const content = `---
model: claude-haiku-3-5
---

  trimmed content  `;

      const { prompt } = new ClaudeCodeAdapter().parseAgent(content);

      expect(prompt).toBe('trimmed content');
    });
  });

  describe('no frontmatter', () => {
    it('returns full content as prompt and empty options when there is no frontmatter', () => {
      const content = 'Just plain text with no frontmatter.';

      const { prompt, options } = new ClaudeCodeAdapter().parseAgent(content);

      expect(prompt).toBe('Just plain text with no frontmatter.');
      expect(options).toEqual({});
    });
  });

  describe('field aliases', () => {
    it('maps "tools" frontmatter key to "allowed_tools" in options', () => {
      const content = `---
tools:
  - Read
  - Write
---

Body text.`;

      const { options } = new ClaudeCodeAdapter().parseAgent(content);

      expect(options.allowed_tools).toEqual(['Read', 'Write']);
      // The alias key must not leak through to the output
      expect((options as Record<string, unknown>)['tools']).toBeUndefined();
    });

    it('coerces comma-string "tools" value to an allowed_tools array', () => {
      const content = `---
tools: Read, Edit, Bash
---

Body text.`;

      const { options } = new ClaudeCodeAdapter().parseAgent(content);

      expect(options.allowed_tools).toEqual(['Read', 'Edit', 'Bash']);
      expect((options as Record<string, unknown>)['tools']).toBeUndefined();
    });
  });

  describe('unknown frontmatter keys', () => {
    it('silently drops unknown frontmatter keys not in ClaudeOptions schema', () => {
      const content = `---
totally_unknown_key: some value
model: sonnet
---

Body.`;

      const { options } = new ClaudeCodeAdapter().parseAgent(content);

      expect((options as Record<string, unknown>)['totally_unknown_key']).toBeUndefined();
      expect(options.model).toBe('sonnet');
    });
  });

  describe('validation errors', () => {
    it('throws PlatformError with PLATFORM_ERROR code for an invalid value on a known key', () => {
      const content = `---\nreasoning_effort: invalid_value\n---\n\nBody.`;
      expect(() => new ClaudeCodeAdapter().parseAgent(content)).toThrow(
        expect.objectContaining({ code: 'PLATFORM_ERROR' })
      );
    });

    it('error message includes the offending field name', () => {
      const content = `---
reasoning_effort: not_a_valid_effort
---

Body.`;

      expect(() => new ClaudeCodeAdapter().parseAgent(content)).toThrow(/reasoning_effort/);
    });
  });

  describe('empty file', () => {
    it('returns empty prompt and empty options for an empty string', () => {
      const { prompt, options } = new ClaudeCodeAdapter().parseAgent('');

      expect(prompt).toBe('');
      expect(options).toEqual({});
    });
  });

  describe('valid options fields', () => {
    it('parses all supported ClaudeOptions fields without error', () => {
      const content = `---
model: claude-opus-4-5
reasoning_effort: high
allowed_tools:
  - Read
denied_tools:
  - Bash
max_budget_usd: 5.0
system_prompt: "You are helpful."
---

Prompt body here.`;

      const { options } = new ClaudeCodeAdapter().parseAgent(content);
      expect(options.model).toBe('claude-opus-4-5');
      expect(options.reasoning_effort).toBe('high');
      expect(options.allowed_tools).toEqual(['Read']);
      expect(options.denied_tools).toEqual(['Bash']);
      expect(options.max_budget_usd).toBe(5.0);
      expect(options.system_prompt).toBe('You are helpful.');
    });
  });

  const __agentsDir = join(
    fileURLToPath(new URL('.', import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    '..',
    '.claude',
    'agents'
  );
  const __agentFiles = existsSync(__agentsDir)
    ? readdirSync(__agentsDir).filter((f) => f.endsWith('.md'))
    : [];
  const __agentsDirMissing = __agentFiles.length === 0;

  describe.skipIf(__agentsDirMissing)('real agent files integration', () => {
    it.each(__agentFiles)(
      'parseAgent returns valid structure for .claude/agents/%s',
      (filename) => {
        const content = readFileSync(join(__agentsDir, filename), 'utf8');
        const result = new ClaudeCodeAdapter().parseAgent(content);

        expect(typeof result.prompt).toBe('string');
        expect(result.prompt.length).toBeGreaterThan(0);
      }
    );
  });
});
