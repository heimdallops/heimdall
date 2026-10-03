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
});
