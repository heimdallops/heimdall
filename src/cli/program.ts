import { Command } from 'commander';

import { EXIT_CODE } from '../errors/cli-error.ts';

export const createProgram = (): Command => {
  const program = new Command();

  program
    .name('heimdall')
    .description('CLI scaffold with strict TypeScript architecture.')
    .option('-c, --config <path>', 'Path to a config file')
    .option('--json', 'Print the final command result as JSON')
    .option('-v, --verbose', 'Enable verbose diagnostics')
    .option('--debug', 'Enable debug diagnostics')
    .showHelpAfterError()
    .showSuggestionAfterError()
    .helpOption('-h, --help', 'Display help')
    .configureOutput({
      outputError: (message: string, write: (value: string) => void): void => {
        write(message);
      },
    });

  program.exitOverride((error) => {
    throw Object.assign(error, {
      exitCode: error.code === 'commander.helpDisplayed' ? 0 : EXIT_CODE.USAGE,
    });
  });

  return program;
};
