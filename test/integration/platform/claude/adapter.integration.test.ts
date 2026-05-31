import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ClaudeCodeAdapter } from '../../../../src/core/platform/claude/adapter.ts';
import type { PlatformError } from '../../../../src/core/platform/errors.ts';
import type { PlatformStream } from '../../../../src/core/platform/types.ts';

const ECHO_AGENT_CONTENT = `---
name: echo
system_prompt: "You are an echo machine. When the user sends a message, reply with ONLY that exact message and nothing else. No greetings, no explanations, no punctuation changes."
---`;

// The SDK spawns a bundled Claude Code CLI binary that accepts ANTHROPIC_API_KEY from the
// environment or the developer's existing Claude Code CLI OAuth credentials (~/.claude/).
const hasCredentials = async (): Promise<boolean> => {
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

const credentialsAvailable = await hasCredentials();

const collectStream = (stream: PlatformStream): Promise<{ output: string; errors: PlatformError[] }> => {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const errors: PlatformError[] = [];

    stream.on('chunk', (delta) => { chunks.push(delta); });
    stream.on('error', (err) => {
      errors.push(err);
      reject(err);
    });
    stream.on('done', () => { resolve({ output: chunks.join(''), errors }); });
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

  it.skipIf(!credentialsAvailable)(
    'echo agent returns hello world',
    async () => {
      const adapter = await ClaudeCodeAdapter.create(tempDir);
      const content = await adapter.findAgent('echo');
      const { options } = adapter.parseAgent(content);

      const stream = adapter.run('hello world', options);
      const { output, errors } = await collectStream(stream);

      expect(errors).toHaveLength(0);
      expect(output.toLowerCase()).toContain('hello world');
      await expect(stream.sessionId()).resolves.toMatch(/.+/);
    },
    30_000
  );
});
