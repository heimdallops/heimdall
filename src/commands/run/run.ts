import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

import { confirm, input, select } from '@inquirer/prompts';

import type { CliContext } from '../../cli/context.ts';
import type { ApprovalResult } from '../../core/engine/emitter.ts';
import { createEngineEmitter } from '../../core/engine/emitter.ts';
import { EngineConfigError, EngineValidationError } from '../../core/engine/errors.ts';
import type { InputDeclaration } from '../../core/engine/schema.ts';
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
 * `filePath` is the absolute path read; `displayPath` is shown in error messages.
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

class InvalidInputError extends CliError {
  public constructor(key: string, value: string, expected: string) {
    super(`Invalid value for input '${key}': '${value}' is not ${expected}`, {
      code: ERROR_CODE.INVALID_INPUT,
      exitCode: EXIT_CODE.USAGE,
    });
    this.name = 'InvalidInputError';
  }
}

/** Coerce a raw `--input` string to the type its declaration expects. */
const coerceInputValue = (
  key: string,
  value: string,
  type: InputDeclaration['type']
): string | number | boolean => {
  switch (type) {
    case 'string':
      return value;
    case 'boolean':
      if (value === 'true') {
        return true;
      }

      if (value === 'false') {
        return false;
      }

      throw new InvalidInputError(key, value, "'true' or 'false'");
    case 'number': {
      const parsed = Number(value);

      if (value.trim() === '' || !Number.isFinite(parsed)) {
        throw new InvalidInputError(key, value, 'a number');
      }

      return parsed;
    }
    case 'integer': {
      const parsed = Number(value);

      if (value.trim() === '' || !Number.isInteger(parsed)) {
        throw new InvalidInputError(key, value, 'an integer');
      }

      return parsed;
    }
  }
};

/** Coerce every supplied `--input` value against its declaration. */
const coerceInputs = (
  rawInputs: Record<string, string>,
  declaredInputs: ReadonlyMap<string, InputDeclaration>
): Record<string, string | number | boolean> => {
  const coerced: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(rawInputs)) {
    coerced[key] = coerceInputValue(key, value, declaredInputs.get(key)?.type ?? 'string');
  }

  return coerced;
};

/**
 * Interactively collect an approval decision. With feedback enabled, the user
 * chooses approve, reject-with-feedback, or reject; feedback accompanies a
 * rejection.
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

  const stdoutIsTty = (stdout as { isTTY?: boolean }).isTTY === true;

  // First interactive-prompt failure, raised after the run returns.
  let approvalError: unknown;

  const abortController = new AbortController();
  const forwardExternalAbort = (): void => {
    abortController.abort();
  };
  if (signal?.aborted) {
    abortController.abort();
  } else {
    signal?.addEventListener('abort', forwardExternalAbort, { once: true });
  }

  try {
    const yaml = await readWorkflowFile(filePath, runInput.file);
    const workflow = await Workflow.from(yaml);

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

    const inputs = coerceInputs(runInput.inputs, declaredInputs);

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

    emitter.on('approval_requested', ({ nodeName, message, enableFeedback, resolve }) => {
      if (runInput.approve) {
        printer.info(`Approval auto-approved for '${nodeName}': ${message}`);
        resolve({ approved: true });

        return;
      }

      if (config.json || !stdoutIsTty) {
        printer.warn(
          `Approval requested for '${nodeName}' auto-declined (non-interactive): ${message}`
        );
        resolve({ approved: false });

        return;
      }

      void (async (): Promise<void> => {
        try {
          resolve(await promptApproval(nodeName, message, enableFeedback));
        } catch (err) {
          approvalError ??= err;
          abortController.abort();
        }
      })();
    });

    const result = await workflow.run({
      inputs,
      emitter,
      cwd,
      signal: abortController.signal,
    });

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
      printer.out(JSON.stringify(result));
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
  } catch (err) {
    if (err instanceof CliError) {
      throw err;
    }

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
  } finally {
    signal?.removeEventListener('abort', forwardExternalAbort);
  }
};
