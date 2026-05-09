import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createPrinter } from '../../../src/output/printer.ts';
import { collectOutput } from './_helpers.ts';

/** Builds a fresh pair of stdout/stderr PassThrough streams for each test. */
const makeStreams = (): { stdout: PassThrough; stderr: PassThrough } => ({
  stdout: new PassThrough(),
  stderr: new PassThrough(),
});

describe('createPrinter — quiet: true suppresses stderr log methods', () => {
  it.each([
    [
      'info',
      (p: ReturnType<typeof createPrinter>): void => {
        p.info('hello from info');
      },
      false,
      false,
    ],
    [
      'success',
      (p: ReturnType<typeof createPrinter>): void => {
        p.success('operation complete');
      },
      false,
      false,
    ],
    [
      'warn',
      (p: ReturnType<typeof createPrinter>): void => {
        p.warn('something to note');
      },
      false,
      false,
    ],
    [
      'verbose',
      (p: ReturnType<typeof createPrinter>): void => {
        p.verbose('verbose detail');
      },
      true,
      false,
    ],
    [
      'debug',
      (p: ReturnType<typeof createPrinter>): void => {
        p.debug('debug detail');
      },
      false,
      true,
    ],
  ])(
    '%s() produces no stderr output when quiet is true',
    async (_method, callMethod, verbose, debug) => {
      const { stdout, stderr } = makeStreams();

      const printer = createPrinter({ stdout, stderr, verbose, debug, quiet: true });

      callMethod(printer);
      stderr.end();

      const output = await collectOutput(stderr);
      expect(output).toBe('');
    }
  );

  it('error() still writes to stderr even when quiet is true', async () => {
    const { stdout, stderr } = makeStreams();

    const printer = createPrinter({
      stdout,
      stderr,
      verbose: false,
      debug: false,
      quiet: true,
    });

    printer.error('something went wrong');
    stderr.end();

    const output = await collectOutput(stderr);
    expect(output).toContain('something went wrong');
  });
});

describe('createPrinter — quiet: true does not suppress out()', () => {
  it('out() writes to stdout even when quiet is true', async () => {
    const { stdout, stderr } = makeStreams();

    const printer = createPrinter({
      stdout,
      stderr,
      verbose: false,
      debug: false,
      quiet: true,
    });

    printer.out('final result');
    stdout.end();

    const output = await collectOutput(stdout);
    expect(output).toContain('final result');
  });
});

describe('createPrinter — quiet: false behaves like the default (non-quiet)', () => {
  it.each([
    [
      'info',
      (p: ReturnType<typeof createPrinter>): void => {
        p.info('an informational message');
      },
      'an informational message',
    ],
    [
      'warn',
      (p: ReturnType<typeof createPrinter>): void => {
        p.warn('a warning');
      },
      'a warning',
    ],
    [
      'error',
      (p: ReturnType<typeof createPrinter>): void => {
        p.error('a fatal error');
      },
      'a fatal error',
    ],
  ])('%s() writes to stderr when quiet is false', async (_method, callMethod, expectedMessage) => {
    const { stdout, stderr } = makeStreams();

    const printer = createPrinter({
      stdout,
      stderr,
      verbose: false,
      debug: false,
      quiet: false,
    });

    callMethod(printer);
    stderr.end();

    const output = await collectOutput(stderr);
    expect(output).toContain(expectedMessage);
  });
});
