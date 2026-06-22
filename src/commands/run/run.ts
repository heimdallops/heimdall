import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';

import type { CliContext } from '../../cli/context.ts';
import { createEngineEmitter } from '../../core/engine/emitter.ts';
import { EngineConfigError, EngineValidationError } from '../../core/engine/errors.ts';
import type { WorkflowResult } from '../../core/engine/workflow.ts';
import { Workflow } from '../../core/engine/workflow.ts';
import { CliError, ERROR_CODE, EXIT_CODE } from '../../errors/cli-error.ts';

export interface RunInput {
  readonly file: string;
  readonly inputs: Record<string, string>;
}

const promptLine = async (prompt: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((res) => {
      rl.question(prompt, (answer) => {
        res(answer);
      });
    });
  } finally {
    rl.close();
  }
};

export const run = async (
  ctx: CliContext,
  input: RunInput,
  signal?: AbortSignal
): Promise<void> => {
  const { printer, cwd, config } = ctx;
  const filePath = resolvePath(cwd, input.file);

  let yaml: string;

  try {
    yaml = await readFile(filePath, 'utf8');
  } catch (err) {
    const isNotFound =
      typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
    throw new CliError(
      isNotFound ? `File not found: ${input.file}` : `Could not read file: ${input.file}`,
      {
        code: isNotFound ? ERROR_CODE.FILE_NOT_FOUND : ERROR_CODE.WORKFLOW_CONFIG_ERROR,
        exitCode: isNotFound ? EXIT_CODE.USAGE : EXIT_CODE.CONFIG,
        cause: err,
      }
    );
  }

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

  for (const key of Object.keys(input.inputs)) {
    if (!declaredInputs.has(key)) {
      throw new CliError(`Unknown input: '${key}' is not declared in this workflow`, {
        code: ERROR_CODE.UNKNOWN_INPUT,
        exitCode: EXIT_CODE.USAGE,
      });
    }
  }

  const missing: string[] = [];

  for (const [name, declaration] of declaredInputs) {
    if (!(name in input.inputs) && declaration.default === undefined) {
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

  emitter.on('approval_requested', ({ nodeId, nodeName, message, enableFeedback, resolve }) => {
    if (config.json) {
      ctx.stderr.write(`${JSON.stringify({ event: 'approval_requested', nodeId, message })}\n`);
      resolve({ approved: false });

      return;
    }

    // Run interactive prompt asynchronously; the emitter listener must return
    // synchronously but we can fire-and-forget the prompt since resolve() is
    // the mechanism for continuing the engine.
    void (async (): Promise<void> => {
      try {
        printer.info(`Approval requested for '${nodeName}': ${message}`);
        const answer = await promptLine('[y/N]: ');
        const normalised = answer.trim().toLowerCase();
        const approved = normalised === 'y' || normalised === 'yes';

        if (approved && enableFeedback) {
          const feedback = await promptLine('Feedback (optional): ');
          resolve({ approved: true, feedback: feedback.trim() || undefined });
        } else {
          resolve({ approved });
        }
      } catch {
        resolve({ approved: false });
      }
    })();
  });

  let result: WorkflowResult;
  try {
    // The engine resolves platform adapters itself via a run-owned factory, so
    // the CLI only forwards inputs, cwd, the cancellation signal, and the emitter.
    result = await workflow.run({ inputs: input.inputs, emitter, cwd, signal });
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
    ctx.stdout.write(
      `${JSON.stringify({ success: result.success, exitReason: result.exitReason })}\n`
    );
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
