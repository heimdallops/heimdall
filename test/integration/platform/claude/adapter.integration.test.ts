import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClaudeCodeAdapter } from '../../../../src/core/platform/claude/adapter.ts';
import type { PlatformError } from '../../../../src/core/platform/errors.ts';
import type { PlatformStream } from '../../../../src/core/platform/types.ts';

// A Claude Code agent definition: the SDK discovers it from .claude/agents under the
// adapter's cwd and applies the body as the agent's system prompt.
const ECHO_AGENT_CONTENT = `---
name: echo
description: Echoes the user message back verbatim
---

You are an echo machine. When the user sends a message, reply with ONLY that exact message and nothing else. No greetings, no explanations, no punctuation changes.
`;

// The SDK spawns a bundled Claude Code CLI binary that accepts ANTHROPIC_API_KEY from the
// environment or the developer's existing Claude Code CLI OAuth credentials (~/.claude/).
const isClaudeAvailable = async (): Promise<boolean> => {
  if (process.env['ANTHROPIC_API_KEY']) {
    return true;
  }

  try {
    await execa('which', ['claude']);

    return true;
  } catch {
    return false;
  }
};

const claudeAvailable = await isClaudeAvailable();

const collectStream = (
  stream: PlatformStream
): Promise<{ output: string; errors: PlatformError[] }> => {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const errors: PlatformError[] = [];

    stream.on('chunk', (delta) => {
      chunks.push(delta);
    });
    stream.on('error', (err) => {
      errors.push(err);
      reject(err);
    });
    stream.on('done', () => {
      resolve({ output: chunks.join(''), errors });
    });
  });
};

describe('ClaudeCodeAdapter integration', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(os.tmpdir(), 'heimdall-adapter-integration-'));
    await mkdir(join(tempDir, '.claude', 'agents'), { recursive: true });
    await writeFile(join(tempDir, '.claude', 'agents', 'echo.md'), ECHO_AGENT_CONTENT, 'utf8');
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it.skipIf(!claudeAvailable)(
    'echo agent resolved by the SDK from .claude/agents returns hello world',
    async () => {
      const adapter = new ClaudeCodeAdapter(tempDir);

      const stream = adapter.run('hello world', { agent: 'echo' });
      const { output } = await collectStream(stream);

      expect(output.toLowerCase()).toContain('hello world');
      await expect(stream.sessionId()).resolves.toMatch(/^\S{8,}$/);
    },
    30_000
  );

  it.skipIf(!claudeAvailable)(
    'resumed session retains context from the previous turn',
    async () => {
      const adapter = new ClaudeCodeAdapter(tempDir);

      const stream1 = adapter.run('My secret word is: zygote. Reply with only: OK', {});
      await collectStream(stream1);
      const sessionId = await stream1.sessionId();

      const stream2 = adapter.run(
        'What was my secret word? Reply with only the word.',
        {},
        sessionId
      );
      const { output } = await collectStream(stream2);

      expect(output.toLowerCase()).toContain('zygote');
    },
    60_000
  );

  it.skipIf(!claudeAvailable)(
    'concurrent streams on the same adapter resolve independent session IDs',
    async () => {
      const adapter = new ClaudeCodeAdapter(tempDir);

      const stream1 = adapter.run('hello', { agent: 'echo' });
      const stream2 = adapter.run('world', { agent: 'echo' });

      await Promise.all([collectStream(stream1), collectStream(stream2)]);

      const [id1, id2] = await Promise.all([stream1.sessionId(), stream2.sessionId()]);

      expect(id1).toMatch(/^\S{8,}$/);
      expect(id2).toMatch(/^\S{8,}$/);
      expect(id1).not.toBe(id2);
    },
    60_000
  );

  it.skipIf(!claudeAvailable)(
    'assembles multi-chunk response correctly',
    async () => {
      const adapter = new ClaudeCodeAdapter(tempDir);

      const chunks: string[] = [];
      const stream = adapter.run(
        'Count from 1 to 20, each number on its own line. Reply with only the numbers.',
        {}
      );

      await new Promise<void>((resolve, reject) => {
        stream.on('chunk', (delta) => chunks.push(delta));
        stream.on('error', reject);
        stream.on('done', resolve);
      });

      const output = chunks.join('');
      expect(output).toMatch(/1/);
      expect(output).toMatch(/20/);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    },
    30_000
  );

  it.skipIf(!claudeAvailable)(
    'chunks from a long response assemble into output exceeding 500 words',
    async () => {
      const adapter = new ClaudeCodeAdapter(tempDir);

      const chunks: string[] = [];
      const stream = adapter.run(
        'Write a short story that is at least 500 words long. Reply with only the story text. Your response must be at least 500 words long. Check that it is 500 words or more then return only the story text.',
        {}
      );

      await new Promise<void>((resolve, reject) => {
        stream.on('chunk', (delta) => chunks.push(delta));
        stream.on('error', reject);
        stream.on('done', resolve);
      });

      const output = chunks.join('');
      const wordCount = output.trim().split(/\s+/).length;
      expect(wordCount).toBeGreaterThan(500);
      expect(chunks.length).toBeGreaterThan(1);
    },
    60_000
  );
});
