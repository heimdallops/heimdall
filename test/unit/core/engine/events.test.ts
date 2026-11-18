import { describe, expect, it } from 'vitest';

import { EngineError, NodeError } from '../../../../src/core/engine/errors.ts';
import {
  jsonReplacer,
  rootErrorMessage,
  serializeError,
} from '../../../../src/core/engine/events.ts';

describe('serializeError', () => {
  it('keeps name, message, code and stack of a NodeError and follows a two-level cause chain', () => {
    const root = new Error('ENOENT: no such file');
    const middle = new EngineError('Could not read prompt', 'ENGINE_PROMPT_READ', { cause: root });
    const top = new NodeError('Node failed', 'ENGINE_NODE_FAILED', 'build', { cause: middle });

    const serialized = serializeError(top);

    expect(serialized).toMatchObject({
      name: 'NodeError',
      message: 'Node failed (node: "build")',
      code: 'ENGINE_NODE_FAILED',
      cause: {
        name: 'EngineError',
        message: 'Could not read prompt',
        code: 'ENGINE_PROMPT_READ',
        cause: { name: 'Error', message: 'ENOENT: no such file' },
      },
    });
    expect(serialized.stack).toContain('NodeError');
    expect(serialized.cause?.cause?.cause).toBeUndefined();
    expect(serialized.cause?.cause?.code).toBeUndefined();
  });

  it('turns a thrown string into a NonError', () => {
    expect(serializeError('boom')).toEqual({ name: 'NonError', message: 'boom' });
  });

  it('turns a plain object into a NonError with its JSON as the message', () => {
    expect(serializeError({ reason: 'bad', count: 2n })).toEqual({
      name: 'NonError',
      message: '{"reason":"bad","count":"2"}',
    });
  });

  it('turns undefined into a NonError', () => {
    expect(serializeError(undefined)).toEqual({ name: 'NonError', message: 'undefined' });
  });

  it('serializes a non-Error cause as a NonError', () => {
    const err = new Error('outer', { cause: 'inner' });
    expect(serializeError(err).cause).toEqual({ name: 'NonError', message: 'inner' });
  });

  it('cuts off a cyclic cause chain', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;

    const serialized = serializeError(a);

    expect(serialized.message).toBe('a');
    expect(serialized.cause?.message).toBe('b');
    expect(serialized.cause?.cause).toBeUndefined();
    expect(() => JSON.stringify(serialized)).not.toThrow();
  });

  it('caps a very deep cause chain at 10 levels', () => {
    let err = new Error('level 0');
    for (let i = 1; i <= 20; i++) {
      err = new Error(`level ${i}`, { cause: err });
    }

    let depth = 0;
    let current = serializeError(err).cause;
    while (current !== undefined) {
      depth++;
      current = current.cause;
    }

    expect(depth).toBe(10);
  });

  it('uses shortMessage, exitCode and signal from an execa-like result', () => {
    const result = {
      shortMessage: 'Command was canceled: bash -c sleep 10',
      message: 'Command was canceled: bash -c sleep 10\n\n<lots of output>',
      exitCode: 143,
      signal: 'SIGTERM',
      isCanceled: true,
    };

    expect(serializeError(result)).toEqual({
      name: 'Error',
      message: 'Command was canceled: bash -c sleep 10',
      exitCode: 143,
      signal: 'SIGTERM',
    });
  });

  it('produces JSON-safe output', () => {
    const serialized = serializeError(new NodeError('x', 'C', 'n', { cause: { a: 1 } }));
    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
  });
});

describe('rootErrorMessage', () => {
  it('returns the innermost Error message under a wrapper', () => {
    const inner = new NodeError(
      'Bash script exited with code 3',
      'ENGINE_BASH_NONZERO_EXIT',
      'lint'
    );
    const outer = new NodeError('Node failed', 'ENGINE_NODE_FAILED', 'lint', { cause: inner });

    expect(rootErrorMessage(outer)).toBe('Bash script exited with code 3 (node: "lint")');
  });

  it('returns the message of an Error with no cause', () => {
    expect(rootErrorMessage(new Error('plain'))).toBe('plain');
  });

  it('stops at the last Error when the cause is not an Error', () => {
    expect(rootErrorMessage(new Error('outer', { cause: 'string cause' }))).toBe('outer');
  });

  it('falls back to String() for non-Errors', () => {
    expect(rootErrorMessage('boom')).toBe('boom');
    expect(rootErrorMessage(undefined)).toBe('undefined');
  });

  it('terminates on a cyclic cause chain', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(rootErrorMessage(a)).toBe('b');
  });
});

describe('jsonReplacer', () => {
  it('writes a small BigInt as a string', () => {
    expect(JSON.stringify({ n: 2n }, jsonReplacer)).toBe('{"n":"2"}');
  });

  it('writes a BigInt beyond MAX_SAFE_INTEGER as a string without rounding', () => {
    const big = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    expect(JSON.stringify({ n: big }, jsonReplacer)).toBe('{"n":"9007199254740993"}');
  });

  it('handles nested BigInts and leaves other values, including plain numbers, alone', () => {
    const value = { a: [1n, { b: -3n }], s: 'x', i: 4, f: 1.5, z: null };
    expect(JSON.stringify(value, jsonReplacer)).toBe(
      '{"a":["1",{"b":"-3"}],"s":"x","i":4,"f":1.5,"z":null}'
    );
  });
});
