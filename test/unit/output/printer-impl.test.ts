import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createPrinter } from '../../../src/output/printer.ts';
import {
  captureOutput,
  collectOutput,
  makeNonTtyStream,
  stripAnsi,
  TtyPassThrough,
} from './_helpers.ts';

describe('createPrinter — debug mode output format', () => {
  it('debug() output contains a timestamp and DEBUG label in [HH:mm:ss] format', async () => {
    const stderr = makeNonTtyStream();
    const stdout = new PassThrough();

    const printer = createPrinter({ stdout, stderr, verbose: false, debug: true, quiet: false });

    const output = await captureOutput(() => {
      printer.debug('timestamped message');
    }, stderr);

    expect(output).toMatch(/\[\d{2}:\d{2}:\d{2}\] DEBUG: timestamped message/);
  });

  it('debug() on a TTY stderr still contains a timestamp', async () => {
    const stderr = new TtyPassThrough();
    const stdout = new PassThrough();

    const printer = createPrinter({ stdout, stderr, verbose: false, debug: true, quiet: false });

    printer.debug('tty timestamp check');
    stderr.end();

    const output = stripAnsi(await collectOutput(stderr));
    expect(output).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
    expect(output).toContain('tty timestamp check');
  });

  it('out() still writes plain text to stdout (no timestamp)', async () => {
    const stderr = new TtyPassThrough();
    const stdout = new PassThrough();

    const printer = createPrinter({ stdout, stderr, verbose: false, debug: true, quiet: false });

    printer.out('stdout result from tty printer');
    stdout.end();

    const output = await collectOutput(stdout);
    expect(output.trim()).toBe('stdout result from tty printer');
  });
});
