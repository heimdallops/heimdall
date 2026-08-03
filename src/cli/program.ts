import { Command } from 'commander';

import packageJson from '../../package.json' with { type: 'json' };
import { EXIT_CODE } from '../errors/cli-error.ts';

export const createProgram = (): Command => {
  const program = new Command();

  program
    .name('heimdall')
    .description('Build deterministic agentic workflows.')
    .version(packageJson.version, '--version', 'Display version')
    .option('-c, --config <path>', 'Path to a config file')
    .option('--json', 'Print the final command result as JSON')
    .option('-v, --verbose', 'Enable verbose diagnostics')
    .option('--debug', 'Enable debug diagnostics')
    .option('-q, --quiet', 'Suppress all diagnostic output')
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
      exitCode:
        error.code === 'commander.helpDisplayed' || error.code === 'commander.version'
          ? 0
          : EXIT_CODE.USAGE,
    });
  });

  return program;
};
