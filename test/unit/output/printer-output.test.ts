import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createPrinter } from '../../../src/output/printer.ts';
import { captureOutput, collectOutput, makeNonTtyStream } from './_helpers.ts';

describe('createPrinter — stderr emits message text', () => {
  it('info() output contains the message', async () => {
    const stderr = makeNonTtyStream();
    const stdout = new PassThrough();

    const printer = createPrinter({ stdout, stderr, verbose: false, debug: false, quiet: false });

    const output = await captureOutput(() => {
      printer.info('hello world');
    }, stderr);

    expect(output.trim()).toEqual('hello world');
  });

  it('warn() output contains the message', async () => {
    const stderr = makeNonTtyStream();
    const stdout = new PassThrough();

    const printer = createPrinter({ stdout, stderr, verbose: false, debug: false, quiet: false });

    const output = await captureOutput(() => {
      printer.warn('be careful');
    }, stderr);

    expect(output.trim()).toEqual('be careful');
  });

  it('error() output contains the message', async () => {
    const stderr = makeNonTtyStream();
    const stdout = new PassThrough();

    const printer = createPrinter({ stdout, stderr, verbose: false, debug: false, quiet: false });

    const output = await captureOutput(() => {
      printer.error('something broke');
    }, stderr);

    expect(output.trim()).toEqual('something broke');
  });

  it('success() output contains the message', async () => {
    const stderr = makeNonTtyStream();
    const stdout = new PassThrough();

    const printer = createPrinter({ stdout, stderr, verbose: false, debug: false, quiet: false });

    const output = await captureOutput(() => {
      printer.success('all done');
    }, stderr);

    expect(output.trim()).toEqual('all done');
  });
});

describe('createPrinter — verbose/debug output', () => {
  it('verbose() output contains the message when verbose is true', async () => {
    const stderr = makeNonTtyStream();
    const stdout = new PassThrough();

    const printer = createPrinter({ stdout, stderr, verbose: true, debug: false, quiet: false });
    const output = await captureOutput(() => {
      printer.verbose('extra detail');
    }, stderr);

    expect(output.trim()).toEqual('extra detail');
  });

  it('debug() output contains the DEBUG label and message when debug is true', async () => {
    const stderr = makeNonTtyStream();
    const stdout = new PassThrough();

    const printer = createPrinter({ stdout, stderr, verbose: false, debug: true, quiet: false });
    const output = await captureOutput(() => {
      printer.debug('trace detail');
    }, stderr);

    expect(output).toMatch(/\[\d{2}:\d{2}:\d{2}\] DEBUG: trace detail/);
  });
});

describe('createPrinter — level gate behavior', () => {
  it('verbose() produces no output when verbose and debug are both false', async () => {
    const stderr = makeNonTtyStream();
    const stdout = new PassThrough();

    const printer = createPrinter({ stdout, stderr, verbose: false, debug: false, quiet: false });
    const output = await captureOutput(() => {
      printer.verbose('should be hidden');
    }, stderr);

    expect(output.trim()).toBe('');
  });

  it('debug() produces no output when verbose and debug are both false', async () => {
    const stderr = makeNonTtyStream();
    const stdout = new PassThrough();

    const printer = createPrinter({ stdout, stderr, verbose: false, debug: false, quiet: false });
    const output = await captureOutput(() => {
      printer.debug('should be hidden');
    }, stderr);

    expect(output.trim()).toBe('');
  });

  it('verbose() produces output when verbose is true', async () => {
    const stderr = makeNonTtyStream();
    const stdout = new PassThrough();

    const printer = createPrinter({ stdout, stderr, verbose: true, debug: false, quiet: false });
    const output = await captureOutput(() => {
      printer.verbose('verbose output');
    }, stderr);

    expect(output).toContain('verbose output');
  });

  it('debug() produces no output when verbose is true but debug is false', async () => {
    const stderr = makeNonTtyStream();
    const stdout = new PassThrough();

    const printer = createPrinter({ stdout, stderr, verbose: true, debug: false, quiet: false });
    const output = await captureOutput(() => {
      printer.debug('too detailed');
    }, stderr);

    expect(output.trim()).toBe('');
  });

  it('verbose() produces output when debug is true (debug implies verbose)', async () => {
    const stderr = makeNonTtyStream();
    const stdout = new PassThrough();

    const printer = createPrinter({ stdout, stderr, verbose: false, debug: true, quiet: false });
    const output = await captureOutput(() => {
      printer.verbose('verbose via debug');
    }, stderr);

    expect(output).toContain('verbose via debug');
  });

  it('debug() produces output when debug is true', async () => {
    const stderr = makeNonTtyStream();
    const stdout = new PassThrough();

    const printer = createPrinter({ stdout, stderr, verbose: false, debug: true, quiet: false });
    const output = await captureOutput(() => {
      printer.debug('debug output');
    }, stderr);

    expect(output).toContain('debug output');
  });
});

describe('createPrinter — out() writes plain text to stdout', () => {
  it('out() output is plain text (not routed through the log formatter)', async () => {
    const stderr = makeNonTtyStream();
    const stdout = new PassThrough();

    const printer = createPrinter({ stdout, stderr, verbose: false, debug: false, quiet: false });

    printer.out('plain result text');
    stdout.end();

    const output = await collectOutput(stdout);
    expect(output.trim()).toBe('plain result text');
  });

  it('out() output does not contain debug headers when debug is true', async () => {
    const stderr = makeNonTtyStream();
    const stdout = new PassThrough();

    const printer = createPrinter({ stdout, stderr, verbose: false, debug: true, quiet: false });

    printer.out('plain result text');
    stdout.end();

    const output = await collectOutput(stdout);
    expect(output.trim()).toBe('plain result text');
  });
});
