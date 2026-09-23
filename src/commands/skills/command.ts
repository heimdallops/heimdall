import type { Command } from 'commander';
import { z } from 'zod';

import { type CliContext, createContext } from '../../cli/context.ts';
// Imported from platform.ts rather than the platform barrel: the barrel re-exports
// ClaudeCodeAdapter, which would pull the Claude Agent SDK into CLI startup.
import { platformSchema } from '../../core/platform/platform.ts';
import { CliError, EXIT_CODE } from '../../errors/cli-error.ts';
import { run as runList } from './list.ts';
import { run as runInstall } from './run.ts';
import { run as runUninstall } from './uninstall.ts';

const SCOPES = ['project', 'user'] as const;

// Zod's default enum message ("expected one of ...") reads as a schema violation rather than
// a CLI usage error, so both enums carry a message naming the value and the valid options.
const unsupported =
  (label: string, supported: readonly string[]) =>
  (issue: { input: unknown }): string =>
    `Unsupported ${label} "${String(issue.input)}". Supported: ${supported.join(', ')}.`;

// Every skills subcommand takes the same target: which agent, and which scope of it.
const targetSchema = z.object({
  platform: z.enum(platformSchema.options, {
    error: unsupported('platform', platformSchema.options),
  }),
  scope: z.enum(SCOPES, { error: unsupported('scope', SCOPES) }),
});

const installSchema = targetSchema.extend({
  force: z.boolean(),
  dryRun: z.boolean(),
});

const uninstallSchema = installSchema.extend({
  yes: z.boolean(),
});

const parseOrThrow = <T>(schema: z.ZodType<T>, code: string, value: unknown): T => {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw new CliError(parsed.error.issues[0]?.message ?? 'Invalid input.', {
      code,
      exitCode: EXIT_CODE.USAGE,
    });
  }

  return parsed.data;
};

const contextFor = async (program: Command): Promise<CliContext> =>
  createContext({
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    flags: program.opts(),
  });

const platformArgument = `Coding agent to target (${platformSchema.options.join(', ')})`;
const scopeOption = `Scope to act on (${SCOPES.join(', ')})`;

export const buildCommand = (program: Command): void => {
  const skills = program.command('skills').description('Manage Heimdall skills for coding agents');

  skills
    .command('install')
    .description("Install Heimdall's workflow-authoring skill into a coding agent")
    .argument('<platform>', platformArgument)
    .option('-s, --scope <scope>', scopeOption, 'project')
    .option('-f, --force', 'Overwrite files that Heimdall did not write', false)
    .option('--dry-run', 'Print the files that would be written without writing them', false)
    .addHelpText(
      'after',
      [
        '',
        'Reinstalling replaces Heimdall’s own output and removes skills this version no',
        'longer ships. Files you added are never removed.',
        '',
        'Examples:',
        '  $ heimdall skills install claude',
        '  $ heimdall skills install claude --scope user',
        '  $ heimdall skills install claude --dry-run',
      ].join('\n')
    )
    .action(async (platform: string, options: unknown): Promise<void> => {
      const input = parseOrThrow(installSchema, 'SKILLS_INSTALL_INVALID_INPUT', {
        platform,
        ...(options as object),
      });

      await runInstall(await contextFor(program), input);
    });

  skills
    .command('uninstall')
    .description('Remove Heimdall-installed skills from a coding agent')
    .argument('<platform>', platformArgument)
    .option('-s, --scope <scope>', scopeOption, 'project')
    .option('-f, --force', 'Also remove a directory with no generated SKILL.md', false)
    .option('--dry-run', 'Print what would be removed without removing it', false)
    .option('-y, --yes', 'Skip the confirmation prompt', false)
    .addHelpText(
      'after',
      [
        '',
        'Removes every skill Heimdall installed, including skills this version no longer',
        'ships. Files Heimdall did not write are always kept, and keep their directory.',
        '',
        'Examples:',
        '  $ heimdall skills uninstall claude',
        '  $ heimdall skills uninstall claude --dry-run',
        '  $ heimdall skills uninstall claude --yes',
      ].join('\n')
    )
    .action(async (platform: string, options: unknown): Promise<void> => {
      const input = parseOrThrow(uninstallSchema, 'SKILLS_UNINSTALL_INVALID_INPUT', {
        platform,
        ...(options as object),
      });

      await runUninstall(await contextFor(program), input);
    });

  skills
    .command('list')
    .description('List the Heimdall skills installed for a coding agent')
    .argument('<platform>', platformArgument)
    .option('-s, --scope <scope>', scopeOption, 'project')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  $ heimdall skills list claude',
        '  $ heimdall skills list claude --scope user',
      ].join('\n')
    )
    .action(async (platform: string, options: unknown): Promise<void> => {
      const input = parseOrThrow(targetSchema, 'SKILLS_LIST_INVALID_INPUT', {
        platform,
        ...(options as object),
      });

      await runList(await contextFor(program), input);
    });
};
