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

  // GIVEN a first run completes and a session ID is captured
  // WHEN adapter.run() is called again with that session ID as the third argument
  // THEN the second stream resolves a session ID, emits done with no errors,
  //      and the model's response reflects awareness of the prior turn's content
  it.skipIf(!credentialsAvailable)(
    'resumed session retains context from the previous turn',
    async () => {
      const adapter = await ClaudeCodeAdapter.create(tempDir);

      const stream1 = adapter.run('My secret word is: zygote. Reply with only: OK', {});
      await collectStream(stream1);
      const sessionId = await stream1.sessionId();

      const stream2 = adapter.run('What was my secret word? Reply with only the word.', {}, sessionId);
      const { output, errors } = await collectStream(stream2);

      expect(errors).toHaveLength(0);
      expect(output.toLowerCase()).toContain('zygote');
    },
    60_000
  );

  // GIVEN an agent fixture whose frontmatter includes a disallowed_tools list
  //       (e.g. disallowed_tools: [Bash])
  // WHEN parseAgent() is called and the returned options are passed to adapter.run()
  // THEN the stream completes without error, confirming the SDK accepted the
  //      disallowed_tools option without rejecting the call
  it.skipIf(!credentialsAvailable)(
    'agent with disallowed_tools frontmatter completes without error',
    async () => {
      const adapter = await ClaudeCodeAdapter.create(tempDir);
      const { options } = adapter.parseAgent('---\nname: no-bash\ndisallowed_tools: [Bash]\n---\n');

      expect(options.disallowed_tools).toEqual(['Bash']);

      const stream = adapter.run('Reply with only: OK', options);
      const { errors } = await collectStream(stream);

      expect(errors).toHaveLength(0);
    },
    30_000
  );

  // GIVEN two calls to adapter.run() are started concurrently on the same adapter instance
  // WHEN both streams are consumed in parallel
  // THEN each stream resolves its own distinct non-empty session ID,
  //      confirming the adapter does not share state between concurrent runs
  it.skipIf(!credentialsAvailable)(
    'concurrent streams on the same adapter resolve independent session IDs',
    async () => {
      const adapter = await ClaudeCodeAdapter.create(tempDir);
      const content = await adapter.findAgent('echo');
      const { options } = adapter.parseAgent(content);

      const stream1 = adapter.run('hello', options);
      const stream2 = adapter.run('world', options);

      const [result1, result2] = await Promise.all([collectStream(stream1), collectStream(stream2)]);

      expect(result1.errors).toHaveLength(0);
      expect(result2.errors).toHaveLength(0);

      const [id1, id2] = await Promise.all([stream1.sessionId(), stream2.sessionId()]);

      expect(id1).toMatch(/.+/);
      expect(id2).toMatch(/.+/);
      expect(id1).not.toBe(id2);
    },
    60_000
  );
});
