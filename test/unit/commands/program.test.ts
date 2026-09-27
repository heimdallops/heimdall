import { describe, expect, it } from 'vitest';

import { createProgram } from '../../../src/cli/program.ts';
import { registerCommands } from '../../../src/cli/register-commands.ts';

describe('program registration', () => {
  it('registers the run command', () => {
    const program = createProgram();
    registerCommands(program);

    const commandNames = program.commands.map((command) => command.name());
    expect(commandNames).toContain('run');
  });

  it('registers the skills command group', () => {
    const program = createProgram();
    registerCommands(program);

    const commandNames = program.commands.map((command) => command.name());
    expect(commandNames).toContain('skills');
  });

  it('registers install under skills with a required platform argument', () => {
    const program = createProgram();
    registerCommands(program);

    const skills = program.commands.find((command) => command.name() === 'skills');
    const install = skills?.commands.find((command) => command.name() === 'install');

    expect(install).toBeDefined();
    expect(install?.usage()).toContain('<platform>');
  });
});
