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
 * Interactively collect an approval decision. When feedback is enabled it is
 * offered as a third choice alongside approve/reject rather than as a separate
 * follow-up question.
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
      { name: 'Approve with feedback', value: 'feedback' },
      { name: 'Reject', value: 'reject' },
    ],
  });

  if (choice === 'reject') {
    return { approved: false };
  }

  if (choice === 'approve') {
    return { approved: true };
  }

  const feedback = await input({ message: 'Feedback:' });

  return { approved: true, feedback: feedback.trim() || undefined };
};

export const run = async (
  ctx: CliContext,
  runInput: RunInput,
  signal?: AbortSignal
): Promise<void> => {
  const { printer, cwd, config } = ctx;
  const filePath = resolvePath(cwd, runInput.file);

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

  emitter.on('approval_requested', ({ nodeName, message, enableFeedback, resolve, reject }) => {
    if (config.json) {
      // --json controls the final result format, not interactivity: there is no
      // TTY to prompt on, so auto-decline and surface it as a normal log line.
      printer.warn(`Approval requested for '${nodeName}' auto-declined in --json mode: ${message}`);
      resolve({ approved: false });

      return;
    }

    // Run interactive prompt asynchronously; the emitter listener must return
    // synchronously but we can fire-and-forget the prompt since resolve()/reject()
    // is the mechanism for continuing the engine.
    void (async (): Promise<void> => {
      try {
        resolve(await promptApproval(nodeName, message, enableFeedback));
      } catch (err) {
        // Don't silently treat a prompt failure as a rejection; fail the workflow.
        reject(err);
      }
    })();
  });

  let result: WorkflowResult;
  try {
    result = await workflow.run({ inputs: runInput.inputs, emitter, signal });
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
