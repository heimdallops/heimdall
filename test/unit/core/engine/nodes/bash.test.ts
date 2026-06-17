import { randomUUID } from 'node:crypto';
import { access, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { createEngineEmitter } from '../../../../../src/core/engine/emitter.ts';
import type {
  ExecutionContext,
  NodeRunCompleted,
  NodeRunResult,
  PlatformAdapter,
} from '../../../../../src/core/engine/nodes/base.ts';
import { BashNode } from '../../../../../src/core/engine/nodes/bash.ts';

const makeCtx = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
  inputs: {},
  vars: {},
  needs: new Map(),
  sessionDir: '/tmp',
  ...overrides,
});

const fakeAdapter = {} as PlatformAdapter;
const emitter = createEngineEmitter();

const makeNode = (raw: Record<string, unknown>): BashNode => BashNode.parse(raw);

const run = (node: BashNode, ctx: ExecutionContext = makeCtx()): Promise<NodeRunResult> =>
  node.run({ ctx, adapter: fakeAdapter, emitter, signal: new AbortController().signal });

const catchRejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    throw new Error('Expected promise to reject but it resolved');
  } catch (err) {
    return err;
  }
};

describe('BashNode', () => {
  describe('HEIMDALL_OUTPUT env var', () => {
    it('injects HEIMDALL_OUTPUT into the script environment', async () => {
      // The script writes the value of HEIMDALL_OUTPUT to HEIMDALL_OUTPUT itself.
      // If the env var is absent the file would be empty; if present it echoes the path.
      const node = makeNode({
        id: 'n1',
        bash: 'echo -n "$HEIMDALL_OUTPUT" > "$HEIMDALL_OUTPUT"',
      });

      const result = await run(node);

      expect(result.status).toBe('completed');
      // The output is the injected HEIMDALL_OUTPUT path — it must start with the system temp dir
      expect(((result as NodeRunCompleted).result['output'] as string).startsWith(tmpdir())).toBe(
        true
      );
    });
  });

  describe('output file reading', () => {
    it('returns the content written to HEIMDALL_OUTPUT', async () => {
      const node = makeNode({
        id: 'n1',
        bash: 'echo -n "hello world" > "$HEIMDALL_OUTPUT"',
      });

      const result = await run(node);

      expect(result).toEqual({
        status: 'completed',
        result: { output: 'hello world' },
      });
    });

    it('returns empty string when nothing is written to HEIMDALL_OUTPUT', async () => {
      const node = makeNode({ id: 'n1', bash: 'true' });

      const result = await run(node);

      expect(result).toEqual({
        status: 'completed',
        result: { output: '' },
      });
    });
  });

  describe('trailing newline stripping', () => {
    it('strips multiple trailing newlines from output', async () => {
      const node = makeNode({
        id: 'n1',
        bash: 'printf "hello\\n\\n\\n" > "$HEIMDALL_OUTPUT"',
      });

      const result = await run(node);

      expect(result).toEqual({
        status: 'completed',
        result: { output: 'hello' },
      });
    });

    it('preserves internal newlines while stripping trailing ones', async () => {
      const node = makeNode({
        id: 'n1',
        bash: 'printf "line1\\nline2\\n" > "$HEIMDALL_OUTPUT"',
      });

      const result = await run(node);

      expect(result).toEqual({
        status: 'completed',
        result: { output: 'line1\nline2' },
      });
    });
  });

  describe('output_format: text (default)', () => {
    it('returns a string when output_format is text', async () => {
      const node = makeNode({
        id: 'n1',
        bash: 'echo -n "result" > "$HEIMDALL_OUTPUT"',
        output_format: 'text',
      });

      const result = await run(node);

      expect(result).toEqual({
        status: 'completed',
        result: { output: 'result' },
      });
    });

    it('returns a string when output_format is omitted (defaults to text)', async () => {
      const node = makeNode({
        id: 'n1',
        bash: 'echo -n "default text" > "$HEIMDALL_OUTPUT"',
      });

      const result = await run(node);

      expect(result).toEqual({
        status: 'completed',
        result: { output: 'default text' },
      });
    });
  });

  describe('output_format: json', () => {
    it('returns a parsed object when HEIMDALL_OUTPUT contains valid JSON', async () => {
      const node = makeNode({
        id: 'n1',
        bash: 'echo -n \'{"key":"value","count":42}\' > "$HEIMDALL_OUTPUT"',
        output_format: 'json',
      });

      const result = await run(node);

      expect(result).toEqual({
        status: 'completed',
        result: { output: { key: 'value', count: 42 } },
      });
    });

    it('returns null when nothing is written to HEIMDALL_OUTPUT with json format', async () => {
      const node = makeNode({
        id: 'n1',
        bash: 'true',
        output_format: 'json',
      });

      const result = await run(node);

      expect(result).toEqual({
        status: 'completed',
        result: { output: null },
      });
    });

    it.each([
      ['array', "'[1,2,3]'", [1, 2, 3]],
      ['number', '"42"', 42],
      ['null', '"null"', null],
      ['boolean', '"true"', true],
      ['string', '\'"hello"\'', 'hello'],
    ])(
      'returns parsed value when HEIMDALL_OUTPUT contains a JSON %s',
      async (_label, literal, expected) => {
        const node = makeNode({
          id: 'n1',
          bash: `echo -n ${literal} > "$HEIMDALL_OUTPUT"`,
          output_format: 'json',
        });

        const result = await run(node);

        expect(result).toEqual({
          status: 'completed',
          result: { output: expected },
        });
      }
    );

    it('throws NodeError when HEIMDALL_OUTPUT contains invalid JSON', async () => {
      const node = makeNode({
        id: 'n1',
        bash: 'echo -n "not valid json" > "$HEIMDALL_OUTPUT"',
        output_format: 'json',
      });

      const err = await catchRejection(run(node));

      expect(err).toMatchObject({ name: 'NodeError', code: 'ENGINE_BASH_JSON_PARSE_ERROR' });
      expect((err as Error).message).toContain('Failed to parse HEIMDALL_OUTPUT as JSON');
    });

    it('skips JSON parsing when the script exits non-zero', async () => {
      // The file contains valid JSON but the script itself fails.
      // The node must throw ENGINE_BASH_NONZERO_EXIT, not ENGINE_BASH_JSON_PARSE_ERROR.
      const node = makeNode({
        id: 'n1',
        bash: 'echo -n \'{"key":"value"}\' > "$HEIMDALL_OUTPUT"; exit 1',
        output_format: 'json',
      });

      const err = await catchRejection(run(node));

      expect(err).toMatchObject({ name: 'NodeError', code: 'ENGINE_BASH_NONZERO_EXIT' });
    });
  });

  describe('non-zero exit', () => {
    it('throws NodeError when the script exits with a non-zero code', async () => {
      const node = makeNode({ id: 'n1', bash: 'exit 1' });

      const err = await catchRejection(run(node));

      expect(err).toMatchObject({ name: 'NodeError', code: 'ENGINE_BASH_NONZERO_EXIT' });
      expect((err as Error).message).toContain('Bash script exited with code 1');
    });

    it('includes the non-zero exit code in the error message', async () => {
      const node = makeNode({ id: 'n1', bash: 'exit 42' });

      const err = await catchRejection(run(node));

      expect(err).toMatchObject({ name: 'NodeError', code: 'ENGINE_BASH_NONZERO_EXIT' });
      expect((err as Error).message).toContain('42');
    });
  });

  describe('host environment passthrough', () => {
    it('passes arbitrary host environment variables through to the script', async () => {
      // A non-allowlisted host variable (e.g. a CLI credential like GH_TOKEN)
      // must reach the script so tools such as `gh`/`aws` keep working.
      const varName = `HEIMDALL_TEST_PASSTHROUGH_${randomUUID().replace(/-/g, '')}`;
      process.env[varName] = 'from-host';

      try {
        const node = makeNode({
          id: 'n1',
          bash: `echo -n "$${varName}" > "$HEIMDALL_OUTPUT"`,
        });

        const result = await run(node);

        expect(result).toEqual({
          status: 'completed',
          result: { output: 'from-host' },
        });
      } finally {
        delete process.env[varName];
      }
    });
  });

  describe('env interpolation', () => {
    it('interpolates CEL expressions in env values before passing them to the script', async () => {
      const node = makeNode({
        id: 'n1',
        bash: 'echo -n "$GREETING" > "$HEIMDALL_OUTPUT"',
        env: { GREETING: 'Hello ${{ inputs.name }}' },
      });

      const result = await run(node, makeCtx({ inputs: { name: 'World' } }));

      expect(result).toEqual({
        status: 'completed',
        result: { output: 'Hello World' },
      });
    });

    it('throws NodeError when env value interpolation fails', async () => {
      const node = makeNode({
        id: 'n1',
        bash: 'true',
        env: { VAR: '${{ inputs.missing.deeply.nested }}' },
      });

      const err = await catchRejection(run(node, makeCtx()));

      expect(err).toMatchObject({ name: 'NodeError', code: 'ENGINE_BASH_INTERPOLATION_ERROR' });
      expect((err as Error).message).toContain('Failed to interpolate bash env values');
    });
  });

  describe('bash field interpolation', () => {
    it('interpolates ${{ }} expressions in the bash field before execution', async () => {
      const node = makeNode({
        id: 'n1',
        bash: 'echo -n "${{ inputs.message }}" > "$HEIMDALL_OUTPUT"',
      });

      const result = await run(node, makeCtx({ inputs: { message: 'interpolated' } }));

      expect(result).toEqual({
        status: 'completed',
        result: { output: 'interpolated' },
      });
    });

    it('throws NodeError when bash field interpolation fails', async () => {
      const node = makeNode({
        id: 'n1',
        bash: 'echo "${{ inputs.missing.deeply.nested }}"',
      });

      const err = await catchRejection(run(node, makeCtx()));

      expect(err).toMatchObject({ name: 'NodeError', code: 'ENGINE_BASH_INTERPOLATION_ERROR' });
      expect((err as Error).message).toContain('Failed to interpolate bash script');
    });
  });

  describe('stdout and stderr isolation', () => {
    it('does not include stdout in the output result', async () => {
      const node = makeNode({
        id: 'n1',
        // stdout goes to the terminal (inherit), not to HEIMDALL_OUTPUT
        bash: 'echo "this is stdout"; echo -n "file content" > "$HEIMDALL_OUTPUT"',
      });

      const result = await run(node);

      expect(result).toEqual({
        status: 'completed',
        result: { output: 'file content' },
      });
    });

    it('does not include stderr in the output result', async () => {
      const node = makeNode({
        id: 'n1',
        bash: 'echo "this is stderr" >&2; echo -n "file content" > "$HEIMDALL_OUTPUT"',
      });

      const result = await run(node);

      expect(result).toEqual({
        status: 'completed',
        result: { output: 'file content' },
      });
    });
  });

  describe('HEIMDALL_OUTPUT temp file cleanup', () => {
    it('deletes the temp file after output is successfully read', async () => {
      // Capture the injected path by having the script write it to HEIMDALL_OUTPUT
      const node = makeNode({
        id: 'n1',
        bash: 'path="$HEIMDALL_OUTPUT"; echo -n "$path" > "$path"',
      });

      const result = await run(node);

      expect(result.status).toBe('completed');
      const capturedPath = (result as NodeRunCompleted).result['output'] as string;

      expect(capturedPath).toBeTruthy();

      // The file must no longer exist after run() returns
      await expect(access(capturedPath)).rejects.toThrow();
    });

    it('deletes the temp file even when the script exits non-zero', async () => {
      // The script writes the injected path to a side-channel file, then exits non-zero.
      const captureFile = join(tmpdir(), `heimdall-test-capture-${randomUUID()}`);

      // Clean up any remnant from a previous test run
      await rm(captureFile, { force: true });

      const node = makeNode({
        id: 'n1',
        bash: `echo -n "$HEIMDALL_OUTPUT" > ${captureFile}; exit 1`,
      });

      const err = await catchRejection(run(node));

      expect(err).toMatchObject({ code: 'ENGINE_BASH_NONZERO_EXIT' });

      // Read the captured path from the side-channel file, then verify it no longer exists
      let capturedPath: string | undefined;

      try {
        capturedPath = (await readFile(captureFile, 'utf8')).trim();
      } finally {
        await rm(captureFile, { force: true });
      }

      expect(capturedPath).toBeTruthy();
      await expect(access(capturedPath)).rejects.toThrow();
    });
  });

  describe('cancellation', () => {
    it('resolves to status: failed (not completed) when the signal is already aborted before run starts', async () => {
      const node = makeNode({ id: 'n1', bash: 'sleep 30' });
      const abortedSignal = AbortSignal.abort();

      const result = await node.run({
        ctx: makeCtx(),
        adapter: fakeAdapter,
        emitter,
        signal: abortedSignal,
      });

      expect(result.status).toBe('failed');
      // Must not have produced a completed result
      expect('result' in result).toBe(false);
    });

    it('resolves to status: failed when the signal is aborted shortly after run starts', async () => {
      const node = makeNode({ id: 'n1', bash: 'sleep 30' });
      const controller = new AbortController();

      // Abort immediately after calling run — execa cancels via cancelSignal before sleep finishes
      const runPromise = node.run({
        ctx: makeCtx(),
        adapter: fakeAdapter,
        emitter,
        signal: controller.signal,
      });

      controller.abort();

      const result = await runPromise;

      expect(result.status).toBe('failed');
      expect('result' in result).toBe(false);
    });
  });

  describe('BashNode.matches', () => {
    it('returns true when raw object has a bash key', () => {
      expect(BashNode.matches({ id: 'n1', bash: 'echo hi' })).toBe(true);
    });

    it('returns false when raw object does not have a bash key', () => {
      expect(BashNode.matches({ id: 'n1', approval: { message: 'hi' } })).toBe(false);
    });
  });

  describe('BashNode.parse', () => {
    it('throws a ZodError when bash field is missing', () => {
      expect(() => BashNode.parse({ id: 'n1' })).toThrow(ZodError);
    });

    it('throws a ZodError when id contains invalid characters', () => {
      expect(() => BashNode.parse({ id: 'bad-id', bash: 'echo hi' })).toThrow(ZodError);
    });

    it('throws a ZodError when output_format is an unrecognized value', () => {
      expect(() => BashNode.parse({ id: 'n1', bash: 'echo hi', output_format: 'xml' })).toThrow(
        ZodError
      );
    });
  });
});
