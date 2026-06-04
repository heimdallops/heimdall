import os from 'node:os';

import { beforeAll, describe, expect, it } from 'vitest';

import { ClaudeCodeAdapter } from '../../../../../src/core/platform/claude/adapter.ts';

describe('parseAgent', () => {
  let adapter: ClaudeCodeAdapter;
  beforeAll(async () => {
    adapter = await ClaudeCodeAdapter.create(os.tmpdir());
  });

  describe('frontmatter + body', () => {
    it('returns body as prompt and frontmatter fields as options', () => {
      const content = `---
model: claude-opus-4-5
---

You are a helpful assistant.`;

      const { prompt, options } = adapter.parseAgent(content);

      expect(prompt).toBe('You are a helpful assistant.');
      expect(options.model).toBe('claude-opus-4-5');
    });

    it('trims leading and trailing whitespace from the body', () => {
      const content = `---
model: claude-haiku-3-5
---

  trimmed content  `;

      const { prompt } = adapter.parseAgent(content);

      expect(prompt).toBe('trimmed content');
    });
  });

  describe('no frontmatter', () => {
    it('returns full content as prompt and empty options when there is no frontmatter', () => {
      const content = 'Just plain text with no frontmatter.';

      const { prompt, options } = adapter.parseAgent(content);

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

      const { options } = adapter.parseAgent(content);

      expect(options.allowed_tools).toEqual(['Read', 'Write']);
      expect((options as Record<string, unknown>)['tools']).toBeUndefined();
    });

    it('coerces comma-string "tools" value to an allowed_tools array', () => {
      const content = `---
tools: Read, Edit, Bash
---

Body text.`;

      const { options } = adapter.parseAgent(content);

      expect(options.allowed_tools).toEqual(['Read', 'Edit', 'Bash']);
      expect((options as Record<string, unknown>)['tools']).toBeUndefined();
    });

    it('prefers allowed_tools over the tools alias when both appear in frontmatter', () => {
      const content = `---
allowed_tools:
  - Write
tools:
  - Read
---

Body.`;
      const { options } = adapter.parseAgent(content);
      expect(options.allowed_tools).toEqual(['Write']);
    });

    it('prefers allowed_tools over the tools alias when tools appears first in frontmatter', () => {
      const content = `---
tools:
  - Read
allowed_tools:
  - Write
---

Body.`;
      const { options } = adapter.parseAgent(content);
      expect(options.allowed_tools).toEqual(['Write']);
    });
  });

  describe('unknown frontmatter keys', () => {
    it('silently drops unknown frontmatter keys not in ClaudeOptions schema', () => {
      const content = `---
totally_unknown_key: some value
model: sonnet
---

Body.`;

      const { options } = adapter.parseAgent(content);

      expect((options as Record<string, unknown>)['totally_unknown_key']).toBeUndefined();
      expect(options.model).toBe('sonnet');
    });
  });

  describe('validation errors', () => {
    it('excludes the invalid field from options', () => {
      const content = `---\nreasoning_effort: invalid_value\n---\n\nBody.`;
      const { options } = adapter.parseAgent(content);
      expect(options.reasoning_effort).toBeUndefined();
    });

    it('retains valid sibling fields and excludes only the invalid field', () => {
      const content = `---\nreasoning_effort: invalid_value\nmodel: claude-opus-4-5\n---\n\nBody.`;
      const { options } = adapter.parseAgent(content);
      expect(options.model).toBe('claude-opus-4-5');
      expect(options.reasoning_effort).toBeUndefined();
    });
  });

  describe('empty file', () => {
    it('returns empty prompt and empty options for an empty string', () => {
      const { prompt, options } = adapter.parseAgent('');

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
disallowed_tools:
  - Bash
max_budget_usd: 5.0
system_prompt: "You are helpful."
---

Prompt body here.`;

      const { options } = adapter.parseAgent(content);
      expect(options.model).toBe('claude-opus-4-5');
      expect(options.reasoning_effort).toBe('high');
      expect(options.allowed_tools).toEqual(['Read']);
      expect(options.disallowed_tools).toEqual(['Bash']);
      expect(options.max_budget_usd).toBe(5.0);
      expect(options.system_prompt).toBe('You are helpful.');
    });
  });
});
