import type { Command } from 'commander';
import { z } from 'zod';

import { createContext } from '../../cli/context.ts';
// Imported from platform.ts rather than the platform barrel: the barrel re-exports
// ClaudeCodeAdapter, which would pull the Claude Agent SDK into CLI startup.
import { platformSchema } from '../../core/platform/platform.ts';
import { CliError, EXIT_CODE } from '../../errors/cli-error.ts';
import { run } from './run.ts';

const SCOPES = ['project', 'user'] as const;

// Zod's default enum message ("expected one of ...") reads as a schema violation rather than
// a CLI usage error, so both enums carry a message naming the value and the valid options.
const unsupported =
  (label: string, supported: readonly string[]) =>
  (issue: { input: unknown }): string =>
    `Unsupported ${label} "${String(issue.input)}". Supported: ${supported.join(', ')}.`;

const inputSchema = z.object({
  platform: z.enum(platformSchema.options, {
    error: unsupported('platform', platformSchema.options),
  }),
  scope: z.enum(SCOPES, { error: unsupported('scope', SCOPES) }),
  force: z.boolean(),
  dryRun: z.boolean(),
});

export const buildCommand = (program: Command): void => {
  const skills = program.command('skills').description('Manage Heimdall skills for coding agents');

  skills
    .command('install')
    .description("Install Heimdall's workflow-authoring skill into a coding agent")
    .argument('<platform>', `Coding agent to install for (${platformSchema.options.join(', ')})`)
    .option('-s, --scope <scope>', `Install scope (${SCOPES.join(', ')})`, 'project')
    .option('-f, --force', 'Overwrite files that Heimdall did not write', false)
    .option('--dry-run', 'Print the files that would be written without writing them', false)
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  $ heimdall skills install claude',
        '  $ heimdall skills install claude --scope user',
        '  $ heimdall skills install claude --dry-run',
      ].join('\n')
    )
    .action(async (platform: string, options: unknown): Promise<void> => {
      const parsed = inputSchema.safeParse({ platform, ...(options as object) });

      if (!parsed.success) {
        throw new CliError(parsed.error.issues[0]?.message ?? 'Invalid input.', {
          code: 'SKILLS_INSTALL_INVALID_INPUT',
          exitCode: EXIT_CODE.USAGE,
        });
      }

      const ctx = await createContext({
        cwd: process.cwd(),
        stdout: process.stdout,
        stderr: process.stderr,
        flags: program.opts(),
      });

      await run(ctx, parsed.data);
    });
};
