import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

import { confirm, input, select } from '@inquirer/prompts';

import type { CliContext } from '../../cli/context.ts';
import type { ApprovalResult } from '../../core/engine/emitter.ts';
import { createEngineEmitter } from '../../core/engine/emitter.ts';
import { EngineConfigError, EngineValidationError } from '../../core/engine/errors.ts';
import type { WorkflowResult } from '../../core/engine/workflow.ts';
import { Workflow } from '../../core/engine/workflow.ts';
import { CliError, ERROR_CODE, EXIT_CODE } from '../../errors/cli-error.ts';

export interface RunInput {
  readonly file: string;
  readonly inputs: Record<string, string>;
  // Auto-approve every approval gate without prompting (the `--approve` flag).
  readonly approve: boolean;
}

/**
 * Read a workflow file, translating filesystem failures into CliErrors.
 * `filePath` is the resolved absolute path read from disk; `displayPath` is the
 * user-supplied path surfaced in error messages.
 */
const readWorkflowFile = async (filePath: string, displayPath: string): Promise<string> => {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    const isNotFound =
      typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
    throw new CliError(
      isNotFound ? `File not found: ${displayPath}` : `Could not read file: ${displayPath}`,
      {
        code: isNotFound ? ERROR_CODE.FILE_NOT_FOUND : ERROR_CODE.WORKFLOW_CONFIG_ERROR,
        exitCode: isNotFound ? EXIT_CODE.USAGE : EXIT_CODE.CONFIG,
        cause: err,
      }
    );
  }
};

/**
 * Interactively collect an approval decision. When feedback is enabled the
 * decision is a single choice between approve, reject-with-feedback, and reject
 * — modeled on the approve/reject/other prompt agents present. Feedback is not a
 * separate follow-up question and it is not an approval: it is a rejection that
 * carries guidance so the workflow can keep trying rather than exit.
 */
const promptApproval = async (
  nodeName: string,
  message: string,
  enableFeedback: boolean
): Promise<ApprovalResult> => {
  const heading = `Approval requested for '${nodeName}': ${message}`;

  if (!enableFeedback) {
    return { approved: await confirm({ message: heading, default: false }) };
  }

  const choice = await select<'approve' | 'feedback' | 'reject'>({
    message: heading,
    default: 'reject',
    choices: [
      { name: 'Approve', value: 'approve' },
      { name: 'Reject with feedback', value: 'feedback' },
      { name: 'Reject', value: 'reject' },
    ],
  });

  if (choice === 'approve') {
    return { approved: true };
  }

  if (choice === 'reject') {
    return { approved: false };
  }

  const feedback = await input({ message: 'Feedback:' });

  return { approved: false, feedback: feedback.trim() || undefined };
};

export const run = async (
  ctx: CliContext,
  runInput: RunInput,
  signal?: AbortSignal
): Promise<void> => {
  const { printer, cwd, config, stdout } = ctx;
  const filePath = resolvePath(cwd, runInput.file);

  // Approval prompts require an interactive terminal. Only tty.WriteStream sets
  // isTTY; a piped or redirected stdout leaves it undefined.
  const stdoutIsTty = (stdout as { isTTY?: boolean }).isTTY === true;

  const yaml = await readWorkflowFile(filePath, runInput.file);

  let workflow: Workflow;

  try {
    workflow = await Workflow.from(yaml);
  } catch (err) {
    if (err instanceof EngineValidationError) {
      throw new CliError(err.toString(), {
        code: ERROR_CODE.WORKFLOW_INVALID,
        exitCode: EXIT_CODE.USAGE,
        cause: err,
      });
    }

    if (err instanceof EngineConfigError) {
      throw new CliError(err.toString(), {
        code: ERROR_CODE.WORKFLOW_CONFIG_ERROR,
        exitCode: EXIT_CODE.CONFIG,
        cause: err,
      });
    }

    throw err;
  }

  const declaredInputs = workflow.inputs;

  for (const key of Object.keys(runInput.inputs)) {
    if (!declaredInputs.has(key)) {
      throw new CliError(`Unknown input: '${key}' is not declared in this workflow`, {
        code: ERROR_CODE.UNKNOWN_INPUT,
        exitCode: EXIT_CODE.USAGE,
      });
    }
  }

  const missing: string[] = [];

  for (const [name, declaration] of declaredInputs) {
    if (!(name in runInput.inputs) && declaration.default === undefined) {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    throw new CliError(
      `Missing required input(s): ${missing.map((name) => `'${name}'`).join(', ')}`,
      {
        code: ERROR_CODE.MISSING_INPUTS,
        exitCode: EXIT_CODE.USAGE,
      }
    );
  }

  const emitter = createEngineEmitter();

  emitter.on('node_started', ({ nodeName }) => {
    printer.info(`Node started: ${nodeName}`);
  });

  emitter.on('node_completed', ({ nodeName }) => {
    printer.success(`Node completed: ${nodeName}`);
  });

  emitter.on('node_skipped', ({ nodeName }) => {
    printer.warn(`Node skipped: ${nodeName}`);
  });

  emitter.on('node_failed', ({ nodeName, error }) => {
    const message = error instanceof Error ? error.message : String(error);
    printer.error(`Node failed: ${nodeName} — ${message}`);
  });

  emitter.on('node_cancelled', ({ nodeName }) => {
    printer.warn(`Node cancelled: ${nodeName}`);
  });

  // Captures the first interactive-prompt failure so the run fails afterward
  // rather than silently proceeding as if the approval were declined.
  let approvalError: unknown;

  emitter.on('approval_requested', ({ nodeName, message, enableFeedback, resolve }) => {
    if (runInput.approve) {
      // --approve short-circuits every gate; the run is explicitly unattended.
      printer.info(`Approval auto-approved for '${nodeName}': ${message}`);
      resolve({ approved: true });

      return;
    }

    if (config.json || !stdoutIsTty) {
      // Without an interactive TTY there is nowhere to prompt, and in --json mode
      // the result stream is machine-readable, so auto-decline in both cases and
      // log a normal message rather than attempting a prompt that would fail.
      printer.warn(
        `Approval requested for '${nodeName}' auto-declined (non-interactive): ${message}`
      );
      resolve({ approved: false });

      return;
    }

    // The emitter listener contract is synchronous (`=> void`), so the async
    // prompt is fire-and-forget: resolve() is the mechanism that continues the
    // engine. An async listener trips @typescript-eslint/no-misused-promises,
    // so the void IIFE is the deliberate way to run async work from here.
    void (async (): Promise<void> => {
      try {
        resolve(await promptApproval(nodeName, message, enableFeedback));
      } catch (err) {
        // A prompt error is not a deliberate rejection; record it so the run
        // fails instead of treating it as a silent decline.
        approvalError ??= err;
        resolve({ approved: false });
      }
    })();
  });

  let result: WorkflowResult;
  try {
    // The engine resolves platform adapters itself via a run-owned factory, so
    // the CLI only forwards inputs, cwd, the cancellation signal, and the emitter.
    result = await workflow.run({ inputs: runInput.inputs, emitter, cwd, signal });
  } catch (err) {
    if (err instanceof EngineConfigError) {
      throw new CliError(err.toString(), {
        code: ERROR_CODE.WORKFLOW_CONFIG_ERROR,
        exitCode: EXIT_CODE.CONFIG,
        cause: err,
      });
    }

    throw err;
  }

  if (approvalError !== undefined) {
    const detail =
      approvalError instanceof Error ? approvalError.message : 'interactive prompt failed';
    throw new CliError(`Approval prompt failed: ${detail}`, {
      code: ERROR_CODE.WORKFLOW_FAILED,
      exitCode: EXIT_CODE.UNKNOWN,
      cause: approvalError,
    });
  }

  if (config.json) {
    printer.out(JSON.stringify({ success: result.success, exitReason: result.exitReason }));
  }

  if (!result.success) {
    const reason = result.exitReason ? ` (${result.exitReason})` : '';
    throw new CliError(`Workflow failed${reason}`, {
      code: ERROR_CODE.WORKFLOW_FAILED,
      exitCode: EXIT_CODE.UNKNOWN,
    });
  }

  if (!config.json) {
    printer.success('Workflow completed successfully');
  }
};
