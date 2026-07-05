import type { Command } from 'commander';

import { createContext } from '../../cli/context.ts';
import { withSignalHandling } from '../../cli/middleware/with-signal-handling.ts';
import { run } from './run.ts';

/**
 * Parse a `key=value` input string, splitting on the first `=` only so that
 * values containing `=` are preserved intact.
 */
const parseInputFlag = (raw: string, previous: Record<string, string>): Record<string, string> => {
  const idx = raw.indexOf('=');

  if (idx === -1) {
    return { ...previous, [raw]: '' };
  }

  const key = raw.slice(0, idx);
  const value = raw.slice(idx + 1);

  return { ...previous, [key]: value };
};

export const registerRunCommand = (program: Command): void => {
  program
    .command('run')
    .description('Execute a workflow YAML file')
    .argument('<file>', 'Path to the workflow YAML file')
    .option(
      '-i, --input <key=value>',
      'Pass a runtime input to the workflow (repeatable; last value wins)',
      parseInputFlag,
      {}
    )
    .option('--approve', 'Automatically approve every approval gate without prompting')
    .action(
      async (
        file: string,
        options: { input: Record<string, string>; approve?: boolean },
        cmd: Command
      ) => {
        const ctx = await createContext({
          cwd: process.cwd(),
          stdout: process.stdout,
          stderr: process.stderr,
          flags: cmd.parent?.opts() ?? {},
        });

        await withSignalHandling(ctx, async (signal) => {
          await run(
            ctx,
            { file, inputs: options.input, approve: options.approve ?? false },
            signal
          );
        });
      }
    );
};
