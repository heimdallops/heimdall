import type { Writable } from 'node:stream';

import { loadConfig } from '../config/load-config.ts';
import type { Config } from '../config/schema.ts';
import { createPrinter, type Printer } from '../output/printer.ts';

export interface CliContext {
  readonly cwd: string;
  readonly config: Config;
  readonly printer: Printer;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly isTui: boolean;
}

export interface ContextOptions {
  readonly cwd: string;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly flags: unknown;
  readonly isTui?: boolean;
}

export const createContext = async (options: ContextOptions): Promise<CliContext> => {
  const config = await loadConfig(options.flags, options.cwd);

  return {
    cwd: options.cwd,
    config,
    printer: createPrinter({
      stdout: options.stdout,
      stderr: options.stderr,
      verbose: config.verbose,
      debug: config.debug,
    }),
    stdout: options.stdout,
    stderr: options.stderr,
    isTui: options.isTui ?? false,
  };
};
