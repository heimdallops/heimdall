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
      await expect(stream.sessionId()).resolves.toMatch(/^\S{8,}$/);
    },
    30_000
  );

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

      expect(id1).toMatch(/^\S{8,}$/);
      expect(id2).toMatch(/^\S{8,}$/);
      expect(id1).not.toBe(id2);
    },
    60_000
  );
});

describe('parseAgent frontmatter validation', () => {
  let tempDir: string;
  let adapter: ClaudeCodeAdapter;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(os.tmpdir(), 'heimdall-parseagent-validation-'));
    await mkdir(join(tempDir, '.claude', 'agents'), { recursive: true });

    const fixtures: { name: string; content: string }[] = [
      {
        name: 'valid-options.md',
        content: `---
name: valid-options
model: claude-opus-4-5
reasoning_effort: high
allowed_tools:
  - Read
  - Edit
disallowed_tools:
  - Bash
max_budget_usd: 10.0
system_prompt: "You are helpful."
---
Body.
`,
      },
      {
        name: 'mixed-frontmatter.md',
        content: `---
name: mixed-frontmatter
model: claude-opus-4-5
reasoning_effort: ultra
---
Body.
`,
      },
      {
        name: 'all-invalid.md',
        content: `---
name: all-invalid
reasoning_effort: turbo
max_budget_usd: "not-a-number"
---
Body.
`,
      },
      {
        name: 'foreign-platform.md',
        content: `---
name: foreign-platform
opencode_provider: anthropic
opencode_model: claude-3-7-sonnet
custom_tool_timeout: 30
---
Body.
`,
      },
      {
        name: 'cross-platform.md',
        content: `---
name: cross-platform
model: claude-sonnet-4-5
opencode_provider: anthropic
custom_tool_timeout: 30
reasoning_effort: high
---
Body.
`,
      },
      {
        name: 'alias-tools.md',
        content: `---
name: alias-tools
tools: Read, Edit
---
Body.
`,
      },
    ];

    for (const fixture of fixtures) {
      await writeFile(join(tempDir, '.claude', 'agents', fixture.name), fixture.content, 'utf8');
    }

    adapter = await ClaudeCodeAdapter.create(tempDir);
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('parses all valid frontmatter fields into options with no dropped fields', async () => {
    const content = await adapter.findAgent('valid-options');
    const { options } = adapter.parseAgent(content);

    expect(options).toEqual({
      model: 'claude-opus-4-5',
      reasoning_effort: 'high',
      allowed_tools: ['Read', 'Edit'],
      disallowed_tools: ['Bash'],
      max_budget_usd: 10.0,
      system_prompt: 'You are helpful.',
    });
  });

  it('includes valid fields and excludes invalid fields', async () => {
    const content = await adapter.findAgent('mixed-frontmatter');
    const { options } = adapter.parseAgent(content);

    expect(options).toEqual({ model: 'claude-opus-4-5' });
  });

  it('returns empty options and does not throw when all known keys have invalid values', async () => {
    const content = await adapter.findAgent('all-invalid');
    const { options } = adapter.parseAgent(content);
    expect(options).toEqual({});
  });

  it('returns empty options when only foreign-platform keys are present', async () => {
    const content = await adapter.findAgent('foreign-platform');
    const { options } = adapter.parseAgent(content);

    expect(options).toEqual({});
  });

  it('includes heimdall-known valid fields and ignores foreign keys', async () => {
    const content = await adapter.findAgent('cross-platform');
    const { options } = adapter.parseAgent(content);

    expect(options).toEqual({ model: 'claude-sonnet-4-5', reasoning_effort: 'high' });
  });

  it('maps "tools" alias to allowed_tools and coerces comma-string to array', async () => {
    const content = await adapter.findAgent('alias-tools');
    const { options } = adapter.parseAgent(content);

    expect(options.allowed_tools).toEqual(['Read', 'Edit']);
    expect((options as Record<string, unknown>)['tools']).toBeUndefined();
  });
});
