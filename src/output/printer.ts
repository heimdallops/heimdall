import type { Writable } from 'node:stream';

import { theme } from './theme.ts';

/** Runtime controls for human/log output routing. */
export interface PrinterOptions {
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly verbose: boolean;
  readonly debug: boolean;
}

/**
 * Semantic output interface for commands and orchestration code.
 *
 * Stream principles:
 * - stdout is reserved for final command output only, including JSON results.
 * - stderr is for errors, warnings, progress, diagnostics, verbose logs, and
 *   debug logs.
 * - `--json` affects final result formatting, not log formatting.
 */
export interface Printer {
  readonly out: (message: string) => void;
  readonly info: (message: string) => void;
  readonly success: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
  readonly verbose: (message: string) => void;
  readonly debug: (message: string) => void;
}

const writeLine = (stream: Writable, message: string): void => {
  stream.write(`${message}\n`);
};

/** Creates a printer bound to the current process streams and log verbosity. */
export const createPrinter = (options: PrinterOptions): Printer => {
  const writeLog = (message: string, colorize: (value: string) => string): void => {
    writeLine(options.stderr, colorize(message));
  };

  const writeVerbose = (message: string): void => {
    if (options.verbose || options.debug) {
      writeLog(message, theme.muted);
    }
  };

  const writeDebug = (message: string): void => {
    if (options.debug) {
      writeLog(message, theme.muted);
    }
  };

  return {
    out: (message: string): void => {
      writeLine(options.stdout, message);
    },
    info: (message: string): void => {
      writeLog(message, theme.info);
    },
    success: (message: string): void => {
      writeLog(message, theme.success);
    },
    warn: (message: string): void => {
      writeLog(message, theme.warning);
    },
    error: (message: string): void => {
      writeLog(message, theme.error);
    },
    verbose: (message: string): void => {
      writeVerbose(message);
    },
    debug: (message: string): void => {
      writeDebug(message);
    },
  };
};
