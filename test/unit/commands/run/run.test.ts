import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliContext } from '../../../../src/cli/context.ts';
import type { RunInput } from '../../../../src/commands/run/run.ts';
import type { ApprovalResult, EngineEmitter } from '../../../../src/core/engine/emitter.ts';
import { EngineConfigError, EngineValidationError } from '../../../../src/core/engine/errors.ts';
import type { WorkflowResult } from '../../../../src/core/engine/workflow.ts';
import { CliError, ERROR_CODE, EXIT_CODE } from '../../../../src/errors/cli-error.ts';
import type { Printer } from '../../../../src/output/printer.ts';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports of the module under test
// ---------------------------------------------------------------------------

// Keep a module-level reference to the Workflow.from mock so we can configure
// it per-test without accessing an unbound static method in every test body.
// Typed to match the signature of Workflow.from (string => Promise<Workflow>).
const workflowFromMock = vi.fn<(yaml: string) => Promise<WorkflowResult>>();

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('node:readline', () => ({
  createInterface: vi.fn(),
}));

vi.mock('../../../../src/core/engine/emitter.ts', () => ({
  createEngineEmitter: vi.fn(),
}));

vi.mock('../../../../src/core/engine/workflow.ts', () => ({
  Workflow: {
    from: workflowFromMock,
  },
}));

// Import the module under test AFTER mocks are declared.
const { run } = await import('../../../../src/commands/run/run.ts');

// Import the mocked modules so we can configure them.
const { readFile } = await import('node:fs/promises');
const { createInterface } = await import('node:readline');
const { createEngineEmitter } = await import('../../../../src/core/engine/emitter.ts');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PrinterSpy = Mock<(message: string) => void>;

interface SpiedPrinter extends Printer {
  readonly info: PrinterSpy;
  readonly success: PrinterSpy;
  readonly warn: PrinterSpy;
  readonly error: PrinterSpy;
  readonly out: PrinterSpy;
  readonly verbose: PrinterSpy;
  readonly debug: PrinterSpy;
}

/**
 * A Workflow-like stub whose run() is controlled per-test.
 * Using Mock<...> for run() gives mockImplementation() its proper type so
 * Promise-returning implementations don't trigger @typescript-eslint/no-misused-promises.
 */
interface WorkflowStub {
  inputs: Map<string, { default?: string }>;
  run: Mock<(options: { inputs: Record<string, string> }) => Promise<WorkflowResult>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal CliContext stub backed by vi.fn() spy methods on the printer.
 * stdout is a PassThrough so tests can inspect JSON output when needed.
 */
const makeCtx = (overrides: Partial<CliContext> = {}): CliContext & { printer: SpiedPrinter } => {
  const stdout = new PassThrough();
  const printer: SpiedPrinter = {
    out: vi.fn<(message: string) => void>(),
    info: vi.fn<(message: string) => void>(),
    success: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
    verbose: vi.fn<(message: string) => void>(),
    debug: vi.fn<(message: string) => void>(),
  };

  return {
    cwd: '/test/cwd',
    config: { json: false, verbose: false, debug: false, quiet: false },
    printer,
    stdout,
    stderr: new PassThrough(),
    isTui: false,
    ...overrides,
  } as CliContext & { printer: SpiedPrinter };
};

/**
 * Build a minimal RunInput.
 */
const makeInput = (overrides: Partial<RunInput> = {}): RunInput => ({
  file: 'workflow.yaml',
  inputs: {},
  ...overrides,
});

/**
 * Create an EventEmitter typed as EngineEmitter.
 */
const makeEmitter = (): EngineEmitter => new EventEmitter() as EngineEmitter;

/**
 * Build a minimal WorkflowStub with controllable inputs and run() behavior.
 */
const makeWorkflowStub = (
  inputDeclarations: Map<string, { default?: string }> = new Map(),
  runResult: WorkflowResult = { success: true }
): WorkflowStub => ({
  inputs: inputDeclarations,
  run: vi
    .fn<(options: { inputs: Record<string, string> }) => Promise<WorkflowResult>>()
    .mockResolvedValue(runResult),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('run command — run()', () => {
  let emitter: EngineEmitter;

  beforeEach(() => {
    vi.clearAllMocks();

    emitter = makeEmitter();
    vi.mocked(createEngineEmitter).mockReturnValue(emitter);

    // Default: readFile resolves with valid YAML content.
    // `as never` bypasses the overloaded readFile signature safely — this is the
    // correct pattern for mocking overloaded built-in functions with vi.fn().
    vi.mocked(readFile).mockResolvedValue('yaml content');

    // Default: Workflow.from() returns a stub with no inputs and success result.
    workflowFromMock.mockResolvedValue(makeWorkflowStub() as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // File I/O errors
  // -------------------------------------------------------------------------

  describe('file not found', () => {
    it('throws CliError with FILE_NOT_FOUND code when readFile rejects', async () => {
      const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
      vi.mocked(readFile).mockRejectedValue(err);

      const ctx = makeCtx();

      await expect(run(ctx, makeInput())).rejects.toMatchObject({
        code: ERROR_CODE.FILE_NOT_FOUND,
      });
    });

    it('wraps any readFile rejection in a CliError, not just ENOENT', async () => {
      vi.mocked(readFile).mockRejectedValue(new Error('EACCES: permission denied'));

      const ctx = makeCtx();
      const err = await run(ctx, makeInput()).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(ERROR_CODE.WORKFLOW_CONFIG_ERROR);
      expect((err as CliError).exitCode).toBe(EXIT_CODE.CONFIG);
    });

    it('includes the user-supplied file path in the error message', async () => {
      const fsErr = Object.assign(new Error('no such file'), { code: 'ENOENT' });
      vi.mocked(readFile).mockRejectedValue(fsErr);

      const ctx = makeCtx({ cwd: '/my/cwd' });
      const err = await run(ctx, makeInput({ file: 'sub/workflow.yaml' })).catch((e: unknown) => e);

      expect((err as CliError).message).toContain('sub/workflow.yaml');
    });
  });

  // -------------------------------------------------------------------------
  // Workflow.from() errors
  // -------------------------------------------------------------------------

  describe('Workflow.from() — EngineValidationError', () => {
    it('throws CliError with WORKFLOW_INVALID code', async () => {
      workflowFromMock.mockRejectedValue(new EngineValidationError('Bad YAML'));

      const ctx = makeCtx();
      const err = await run(ctx, makeInput()).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(ERROR_CODE.WORKFLOW_INVALID);
    });

    it('surfaces the engine error message in the CliError', async () => {
      const cause = new Error('unexpected token at line 3');
      workflowFromMock.mockRejectedValue(
        new EngineValidationError('Workflow failed schema validation', { cause })
      );

      const ctx = makeCtx();
      const err = await run(ctx, makeInput()).catch((e: unknown) => e);

      expect((err as CliError).message).toContain('Workflow failed schema validation');
      expect((err as CliError).message).toContain('unexpected token at line 3');
    });
  });

  describe('Workflow.from() — EngineConfigError', () => {
    it('throws CliError with WORKFLOW_CONFIG_ERROR code', async () => {
      workflowFromMock.mockRejectedValue(new EngineConfigError('Cycle detected'));

      const ctx = makeCtx();
      const err = await run(ctx, makeInput()).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(ERROR_CODE.WORKFLOW_CONFIG_ERROR);
    });

    it('re-throws unexpected errors from Workflow.from() without wrapping', async () => {
      const unexpected = new TypeError('completely unexpected');
      workflowFromMock.mockRejectedValue(unexpected);

      const ctx = makeCtx();
      const err = await run(ctx, makeInput()).catch((e: unknown) => e);

      expect(err).toBe(unexpected);
    });
  });

  // -------------------------------------------------------------------------
  // Input validation — unknown key
  // -------------------------------------------------------------------------

  describe('unknown --input key', () => {
    it('throws CliError with UNKNOWN_INPUT code when a key is not declared', async () => {
      workflowFromMock.mockResolvedValue(makeWorkflowStub(new Map()) as never);

      const ctx = makeCtx();
      const err = await run(ctx, makeInput({ inputs: { ghost: 'value' } })).catch(
        (e: unknown) => e
      );

      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(ERROR_CODE.UNKNOWN_INPUT);
    });

    it('names the unknown key in the error message', async () => {
      workflowFromMock.mockResolvedValue(makeWorkflowStub(new Map()) as never);

      const ctx = makeCtx();
      const err = await run(ctx, makeInput({ inputs: { ghost: 'value' } })).catch(
        (e: unknown) => e
      );

      expect((err as CliError).message).toContain('ghost');
    });

    it('rejects the first unknown key seen even when the workflow declares other inputs', async () => {
      workflowFromMock.mockResolvedValue(makeWorkflowStub(new Map([['known', {}]])) as never);

      const ctx = makeCtx();
      const err = await run(ctx, makeInput({ inputs: { known: 'x', unknown_key: 'y' } })).catch(
        (e: unknown) => e
      );

      expect((err as CliError).code).toBe(ERROR_CODE.UNKNOWN_INPUT);
      expect((err as CliError).message).toContain('unknown_key');
    });
  });

  // -------------------------------------------------------------------------
  // Input validation — missing required inputs
  // -------------------------------------------------------------------------

  describe('missing required inputs', () => {
    it('throws CliError with MISSING_INPUTS code when a required input has no value', async () => {
      workflowFromMock.mockResolvedValue(makeWorkflowStub(new Map([['token', {}]])) as never);

      const ctx = makeCtx();
      const err = await run(ctx, makeInput({ inputs: {} })).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(ERROR_CODE.MISSING_INPUTS);
    });

    it('lists all missing input names in the error message', async () => {
      workflowFromMock.mockResolvedValue(
        makeWorkflowStub(
          new Map([
            ['token', {}],
            ['region', {}],
          ])
        ) as never
      );

      const ctx = makeCtx();
      const err = await run(ctx, makeInput({ inputs: {} })).catch((e: unknown) => e);

      const { message } = err as CliError;
      expect(message).toContain('token');
      expect(message).toContain('region');
    });

    it('does not throw MISSING_INPUTS when the input has a default value', async () => {
      const workflowStub = makeWorkflowStub(new Map([['region', { default: 'us-east-1' }]]));
      workflowFromMock.mockResolvedValue(workflowStub as never);

      const ctx = makeCtx();

      // No inputs provided — region has a default so it should be fine
      await expect(run(ctx, makeInput({ inputs: {} }))).resolves.toBeUndefined();
    });

    it('does not throw when all required inputs are provided', async () => {
      const workflowStub = makeWorkflowStub(new Map([['token', {}]]));
      workflowFromMock.mockResolvedValue(workflowStub as never);

      const ctx = makeCtx();

      await expect(run(ctx, makeInput({ inputs: { token: 'abc' } }))).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Input edge cases
  // -------------------------------------------------------------------------

  describe('input edge cases', () => {
    it('passes input values to workflow.run() unchanged, including "=" characters', async () => {
      // The RunInput.inputs map already merges duplicates (via parseInputFlag in command.ts).
      // Verify that the value passed through arrives intact in workflow.run().
      const workflowStub = makeWorkflowStub(new Map([['url', {}]]));
      workflowFromMock.mockResolvedValue(workflowStub as never);

      const ctx = makeCtx();
      await run(ctx, makeInput({ inputs: { url: 'https://x.com?a=1&b=2' } }));

      expect(workflowStub.run).toHaveBeenCalledWith(
        expect.objectContaining({ inputs: { url: 'https://x.com?a=1&b=2' } })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Engine event → printer method mapping
  // -------------------------------------------------------------------------

  describe('engine event listeners', () => {
    /**
     * Build a workflow stub whose run() emits the given events before resolving.
     * The run() implementation is a plain synchronous-returning function that
     * returns a resolved Promise — avoids the `no-misused-promises` rule.
     */
    const makeWorkflowWithEvents = (events: (() => void)[]): WorkflowStub => {
      const stub = makeWorkflowStub();

      stub.run.mockImplementation((): Promise<WorkflowResult> => {
        for (const emitFn of events) {
          emitFn();
        }

        return Promise.resolve({ success: true });
      });

      return stub;
    };

    it('calls printer.info when node_started fires', async () => {
      const workflowStub = makeWorkflowWithEvents([
        (): void => {
          emitter.emit('node_started', { nodeId: 'n1', nodeName: 'My Node' });
        },
      ]);
      workflowFromMock.mockResolvedValue(workflowStub as never);

      const ctx = makeCtx();
      await run(ctx, makeInput());

      expect(ctx.printer.info).toHaveBeenCalledWith(expect.stringContaining('My Node'));
    });

    it('calls printer.success when node_completed fires', async () => {
      const workflowStub = makeWorkflowWithEvents([
        (): void => {
          emitter.emit('node_completed', { nodeId: 'n1', nodeName: 'My Node', result: {} });
        },
      ]);
      workflowFromMock.mockResolvedValue(workflowStub as never);

      const ctx = makeCtx();
      await run(ctx, makeInput());

      expect(ctx.printer.success).toHaveBeenCalledWith(expect.stringContaining('My Node'));
    });

    it('calls printer.warn when node_skipped fires', async () => {
      const workflowStub = makeWorkflowWithEvents([
        (): void => {
          emitter.emit('node_skipped', { nodeId: 'n1', nodeName: 'My Node' });
        },
      ]);
      workflowFromMock.mockResolvedValue(workflowStub as never);

      const ctx = makeCtx();
      await run(ctx, makeInput());

      expect(ctx.printer.warn).toHaveBeenCalledWith(expect.stringContaining('My Node'));
    });

    it('calls printer.warn when node_cancelled fires', async () => {
      const workflowStub = makeWorkflowWithEvents([
        (): void => {
          emitter.emit('node_cancelled', { nodeId: 'n1', nodeName: 'My Node' });
        },
      ]);
      workflowFromMock.mockResolvedValue(workflowStub as never);

      const ctx = makeCtx();
      await run(ctx, makeInput());

      expect(ctx.printer.warn).toHaveBeenCalledWith(expect.stringContaining('My Node'));
    });

    it('calls printer.error when node_failed fires with an Error object', async () => {
      const workflowStub = makeWorkflowWithEvents([
        (): void => {
          emitter.emit('node_failed', {
            nodeId: 'n1',
            nodeName: 'My Node',
            error: new Error('boom'),
          });
        },
      ]);
      workflowFromMock.mockResolvedValue(workflowStub as never);

      const ctx = makeCtx();
      await run(ctx, makeInput());

      expect(ctx.printer.error).toHaveBeenCalledWith(expect.stringContaining('My Node'));
      expect(ctx.printer.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });

    it('calls printer.error when node_failed fires with a non-Error value', async () => {
      const workflowStub = makeWorkflowWithEvents([
        (): void => {
          emitter.emit('node_failed', {
            nodeId: 'n1',
            nodeName: 'Fail Step',
            error: 'string error',
          });
        },
      ]);
      workflowFromMock.mockResolvedValue(workflowStub as never);

      const ctx = makeCtx();
      await run(ctx, makeInput());

      expect(ctx.printer.error).toHaveBeenCalledWith(expect.stringContaining('string error'));
    });
  });

  // -------------------------------------------------------------------------
  // Workflow result handling
  // -------------------------------------------------------------------------

  describe('workflow completion', () => {
    it('calls printer.success with a completion message when the workflow succeeds', async () => {
      workflowFromMock.mockResolvedValue(makeWorkflowStub(new Map(), { success: true }) as never);

      const ctx = makeCtx();
      await run(ctx, makeInput());

      // At least one printer.success call should mention completion
      const calls = vi.mocked(ctx.printer.success).mock.calls.map(([msg]) => msg);
      expect(calls.some((m) => /complet/i.test(m))).toBe(true);
    });

    it('throws CliError when the workflow result has success:false', async () => {
      workflowFromMock.mockResolvedValue(makeWorkflowStub(new Map(), { success: false }) as never);

      const ctx = makeCtx();
      const err = await run(ctx, makeInput()).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(CliError);
    });

    it('includes the exitReason in the CliError message when the workflow fails with a reason', async () => {
      workflowFromMock.mockResolvedValue(
        makeWorkflowStub(new Map(), { success: false, exitReason: 'gate_rejected' }) as never
      );

      const ctx = makeCtx();
      const err = await run(ctx, makeInput()).catch((e: unknown) => e);

      expect((err as CliError).message).toContain('gate_rejected');
    });
  });

  // -------------------------------------------------------------------------
  // JSON mode
  // -------------------------------------------------------------------------

  describe('--json flag', () => {
    it('writes {"success":true,...} to stdout when the workflow succeeds in JSON mode', async () => {
      workflowFromMock.mockResolvedValue(makeWorkflowStub(new Map(), { success: true }) as never);

      const stdoutChunks: Buffer[] = [];
      const stdout = new PassThrough();
      stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));

      const ctx = makeCtx({
        config: { json: true, verbose: false, debug: false, quiet: false },
        stdout,
      });
      await run(ctx, makeInput());
      stdout.end();

      const output = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const parsed = JSON.parse(output) as Record<string, unknown>;
      expect(parsed['success']).toBe(true);
    });

    it('writes {"success":false,...} to stdout when the workflow fails in JSON mode', async () => {
      workflowFromMock.mockResolvedValue(makeWorkflowStub(new Map(), { success: false }) as never);

      const stdoutChunks: Buffer[] = [];
      const stdout = new PassThrough();
      stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));

      const ctx = makeCtx({
        config: { json: true, verbose: false, debug: false, quiet: false },
        stdout,
      });

      await run(ctx, makeInput()).catch((): void => {
        // failure path throws — that is expected; we still want to check stdout
      });
      stdout.end();

      const output = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const parsed = JSON.parse(output) as Record<string, unknown>;
      expect(parsed['success']).toBe(false);
    });

    it('does not call printer.success with a workflow-complete message in JSON mode', async () => {
      workflowFromMock.mockResolvedValue(makeWorkflowStub(new Map(), { success: true }) as never);

      const ctx = makeCtx({
        config: { json: true, verbose: false, debug: false, quiet: false },
      });
      await run(ctx, makeInput());

      // printer.success may be called for node events, but NOT for the workflow-level message
      const completionCalls = vi
        .mocked(ctx.printer.success)
        .mock.calls.filter(([msg]) => /workflow complet/i.test(msg));
      expect(completionCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // approval_requested — non-JSON mode
  // -------------------------------------------------------------------------

  describe('approval_requested — interactive mode', () => {
    const makeReadlineStub = (
      answers: string[]
    ): { question: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } => {
      let callIndex = 0;

      return {
        question: vi.fn((_prompt: string, cb: (answer: string) => void): void => {
          cb(answers[callIndex++] ?? '');
        }),
        close: vi.fn(),
      };
    };

    const makeApprovalWorkflowStub = (
      enableFeedback: boolean,
      onResolve: (result: ApprovalResult) => void
    ): WorkflowStub => {
      const stub = makeWorkflowStub();

      stub.run.mockImplementation((): Promise<WorkflowResult> => {
        emitter.emit('approval_requested', {
          nodeId: 'n1',
          nodeName: 'Gate',
          message: 'Continue?',
          enableFeedback,
          resolve: onResolve,
        });

        // Give the async prompt handler a chance to run before the workflow "completes".
        // Two chained microtask ticks cover the worst case of two sequential prompt
        // awaits (e.g. approval + feedback), each of which consumes one tick.
        return Promise.resolve()
          .then(() => Promise.resolve())
          .then(() => ({ success: true }));
      });

      return stub;
    };

    it('prompts with [y/N]: when stdin returns "y"', async () => {
      const rlStub = makeReadlineStub(['y']);
      vi.mocked(createInterface).mockReturnValue(rlStub as never);

      const workflowStub = makeApprovalWorkflowStub(false, vi.fn());
      workflowFromMock.mockResolvedValue(workflowStub as never);

      const ctx = makeCtx();
      await run(ctx, makeInput());

      const { question } = rlStub;
      expect(question).toHaveBeenCalledWith('[y/N]: ', expect.any(Function));
    });

    it('calls resolve({approved:false}) when stdin returns "n"', async () => {
      const rlStub = makeReadlineStub(['n']);
      vi.mocked(createInterface).mockReturnValue(rlStub as never);

      let resolvedResult: ApprovalResult | undefined;
      const workflowStub = makeApprovalWorkflowStub(false, (result): void => {
        resolvedResult = result;
      });
      workflowFromMock.mockResolvedValue(workflowStub as never);

      const ctx = makeCtx();
      await run(ctx, makeInput());

      expect(resolvedResult).toBeDefined();
      expect(resolvedResult!.approved).toBe(false);
    });

    it('prompts for feedback after approval when enableFeedback is true and user approves', async () => {
      const rlStub = makeReadlineStub(['yes', 'looks good']);
      vi.mocked(createInterface).mockReturnValue(rlStub as never);

      let resolvedResult: ApprovalResult | undefined;
      const workflowStub = makeApprovalWorkflowStub(true, (result): void => {
        resolvedResult = result;
      });
      workflowFromMock.mockResolvedValue(workflowStub as never);

      const ctx = makeCtx();
      await run(ctx, makeInput());

      expect(resolvedResult?.approved).toBe(true);
      expect(resolvedResult?.feedback).toBe('looks good');
    });

    it('does NOT prompt for feedback when enableFeedback is true but user denies', async () => {
      let questionCallCount = 0;
      const rlStub = {
        question: vi.fn((_prompt: string, cb: (answer: string) => void): void => {
          questionCallCount++;
          cb('n');
        }),
        close: vi.fn(),
      };
      vi.mocked(createInterface).mockReturnValue(rlStub as never);

      const workflowStub = makeApprovalWorkflowStub(true, vi.fn());
      workflowFromMock.mockResolvedValue(workflowStub as never);

      const ctx = makeCtx();
      await run(ctx, makeInput());

      // Only the [y/N] question; no feedback question
      expect(questionCallCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // approval_requested — JSON mode
  // -------------------------------------------------------------------------

  describe('approval_requested — JSON mode', () => {
    it('calls resolve({approved:false}) without prompting stdin in JSON mode', async () => {
      let resolvedResult: ApprovalResult | undefined;

      const workflowStub = makeWorkflowStub();
      workflowStub.run.mockImplementation((): Promise<WorkflowResult> => {
        emitter.emit('approval_requested', {
          nodeId: 'n1',
          nodeName: 'Gate',
          message: 'Continue?',
          enableFeedback: false,
          resolve: (result): void => {
            resolvedResult = result;
          },
        });

        return Promise.resolve({ success: true });
      });
      workflowFromMock.mockResolvedValue(workflowStub as never);

      const ctx = makeCtx({
        config: { json: true, verbose: false, debug: false, quiet: false },
      });
      await run(ctx, makeInput());

      expect(resolvedResult).toBeDefined();
      expect(resolvedResult!.approved).toBe(false);
      // createInterface should NOT have been called — no stdin prompt
      expect(createInterface).not.toHaveBeenCalled();
    });

    it('writes an approval_requested JSON event to stderr in JSON mode', async () => {
      const stderrChunks: Buffer[] = [];
      const stderr = new PassThrough();
      stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      const workflowStub = makeWorkflowStub();
      workflowStub.run.mockImplementation((): Promise<WorkflowResult> => {
        emitter.emit('approval_requested', {
          nodeId: 'approval-node',
          nodeName: 'Gate',
          message: 'Please approve',
          enableFeedback: false,
          resolve: vi.fn(),
        });

        return Promise.resolve({ success: true });
      });
      workflowFromMock.mockResolvedValue(workflowStub as never);

      const ctx = makeCtx({
        config: { json: true, verbose: false, debug: false, quiet: false },
        stderr,
      });
      await run(ctx, makeInput());
      stderr.end();

      const output = Buffer.concat(stderrChunks).toString('utf8');
      const lines = output.trim().split('\n').filter(Boolean);

      const approvalLine = lines.find((l) => l.includes('approval_requested'));
      expect(approvalLine).toBeDefined();
      const parsed = JSON.parse(approvalLine!) as Record<string, unknown>;
      expect(parsed['event']).toBe('approval_requested');
      expect(parsed['nodeId']).toBe('approval-node');
    });
  });
});
