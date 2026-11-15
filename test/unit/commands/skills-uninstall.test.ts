import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createProgram } from '../../../src/cli/program.ts';
import { registerCommands } from '../../../src/cli/register-commands.ts';

const subcommand = (name: string): Command | undefined => {
  const program = createProgram();
  registerCommands(program);

  const skills = program.commands.find((command) => command.name() === 'skills');

  return skills?.commands.find((command) => command.name() === name);
};

describe('skills uninstall registration', () => {
  it('is registered under skills with a required platform argument', () => {
    const uninstall = subcommand('uninstall');

    expect(uninstall).toBeDefined();
    expect(uninstall?.usage()).toContain('<platform>');
  });

  it('accepts the flags that bound a destructive run', () => {
    const flags = subcommand('uninstall')
      ?.options.map((option) => option.long)
      .filter((long): long is string => long !== undefined);

    expect(flags).toEqual(expect.arrayContaining(['--scope', '--force', '--dry-run', '--yes']));
  });

  it('defaults scope to project and every switch to off', () => {
    const defaults = new Map<string | undefined, unknown>(
      (subcommand('uninstall')?.options ?? []).map((option) => [option.long, option.defaultValue])
    );

    expect(defaults.get('--scope')).toBe('project');
    expect(defaults.get('--dry-run')).toBe(false);
    expect(defaults.get('--yes')).toBe(false);
    expect(defaults.get('--force')).toBe(false);
  });
});

describe('skills list registration', () => {
  it('is registered under skills with a required platform argument', () => {
    const list = subcommand('list');

    expect(list).toBeDefined();
    expect(list?.usage()).toContain('<platform>');
  });

  // list only reads, so it must not carry any of the flags that change the filesystem.
  it('exposes scope and nothing destructive', () => {
    const flags = subcommand('list')?.options.map((option) => option.long);

    expect(flags).toEqual(['--scope']);
  });
});
