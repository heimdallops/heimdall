import type { Command } from 'commander';

/**
 * Registers all concrete command modules with the root Commander program.
 *
 * Keep this module limited to importing command builders and invoking them.
 * Command parsing, validation, and runtime behavior belong in each command's
 * own `command.ts` and `run.ts` files.
 */
export const registerCommands = (program: Command): void => {
  void program;
};
