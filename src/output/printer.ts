import type { Writable } from 'node:stream';

import { Chalk } from 'chalk';

export interface PrinterOptions {
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly verbose: boolean;
  readonly debug: boolean;
  readonly quiet: boolean;
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

type Level = 'silent' | 'info' | 'verbose' | 'debug';

const resolveLevel = (options: Pick<PrinterOptions, 'quiet' | 'verbose' | 'debug'>): Level => {
  if (options.quiet) {
    return 'silent';
  }

  if (options.debug) {
    return 'debug';
  }

  if (options.verbose) {
    return 'verbose';
  }

  return 'info';
};

export const createPrinter = (options: PrinterOptions): Printer => {
  const level = resolveLevel(options);
  const isTty = 'isTTY' in options.stderr && (options.stderr as NodeJS.WriteStream).isTTY === true;
  const c = new Chalk(isTty ? {} : { level: 0 });
  const labels = {
    info: c.cyan('INFO'),
    success: c.green('SUCCESS'),
    warn: c.yellow('WARN'),
    error: c.red('ERROR'),
    verbose: c.gray('VERBOSE'),
    debug: c.dim('DEBUG'),
  };

  const logPrefix = (label: string): string => {
    if (level !== 'debug') {
      return '';
    }

    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    return `[${time}] ${label}: `;
  };

  const log = (label: string, message: string): void => {
    if (level === 'silent') {
      return;
    }

    options.stderr.write(`${logPrefix(label)}${message}\n`);
  };

  return {
    out: (message: string): void => {
      options.stdout.write(`${message}\n`);
    },
    info: (message: string): void => {
      log(labels.info, message);
    },
    success: (message: string): void => {
      log(labels.success, message);
    },
    warn: (message: string): void => {
      log(labels.warn, message);
    },
    error: (message: string): void => {
      // Errors always surface regardless of --quiet.
      options.stderr.write(`${logPrefix(labels.error)}${message}\n`);
    },
    verbose: (message: string): void => {
      if (level !== 'verbose' && level !== 'debug') {
        return;
      }

      log(labels.verbose, message);
    },
    debug: (message: string): void => {
      if (level !== 'debug') {
        return;
      }

      log(labels.debug, message);
    },
  };
};
