import { EvaluationError } from '@marcbachmann/cel-js';
import { describe, expect, it } from 'vitest';

import { evalCel, interpolate } from '../../../../src/core/engine/cel.ts';
import type { EngineError } from '../../../../src/core/engine/errors.ts';

type CelContext = Record<string, unknown>;

const makeCtx = (overrides?: Partial<CelContext>): CelContext => ({
  inputs: {},
  vars: {},
  needs: new Map(),
  sessionDir: '/tmp/session',
  ...overrides,
});

describe('interpolate', () => {
  it('substitutes a single ${{ }} expression with the value from ctx.inputs', () => {
    const ctx = makeCtx({ inputs: { name: 'Alice' } });

    const result = interpolate('Hello, ${{ inputs.name }}!', ctx);

    expect(result).toBe('Hello, Alice!');
  });

  it('throws EngineError with code ENGINE_CEL_ERROR when the expression references an undefined variable', () => {
    expect.assertions(3);
    const ctx = makeCtx({ inputs: {} });

    let thrown: EngineError | undefined;
    try {
      interpolate('${{ inputs.missing }}', ctx);
    } catch (err) {
      thrown = err as EngineError;
    }

    expect(thrown?.code).toBe('ENGINE_CEL_ERROR');
    expect(thrown?.message).toBe('CEL evaluation failed');
    expect(thrown?.cause).toBeInstanceOf(Error);
  });

  it('returns the original string unchanged when there are no ${{ }} blocks', () => {
    const ctx = makeCtx({ inputs: { name: 'Bob' } });

    const result = interpolate('no interpolation here', ctx);

    expect(result).toBe('no interpolation here');
  });

  it('substitutes multiple ${{ }} expressions in a single template, each replaced correctly', () => {
    const ctx = makeCtx({ inputs: { first: 'Jane', last: 'Doe' } });

    const result = interpolate('${{ inputs.first }} ${{ inputs.last }}', ctx);

    expect(result).toBe('Jane Doe');
  });

  it('serializes a number result to its decimal string representation', () => {
    const ctx = makeCtx({ inputs: { count: 42 } });

    const result = interpolate('value=${{ inputs.count }}', ctx);

    expect(result).toBe('value=42');
  });

  it('serializes a BigInt arithmetic result to its decimal string representation', () => {
    const ctx = makeCtx({ inputs: { count: 5n } });

    const result = interpolate('${{ inputs.count + 1 }}', ctx);

    expect(result).toBe('6');
  });

  it('serializes a boolean result to its string representation', () => {
    const ctx = makeCtx({ inputs: { enabled: true } });

    const result = interpolate('flag=${{ inputs.enabled }}', ctx);

    expect(result).toBe('flag=true');
  });

  it('serializes a plain-object result to its JSON string representation', () => {
    const ctx = makeCtx({ needs: new Map([['step', { key: 'val' }]]) });

    const result = interpolate('${{ needs.step }}', ctx);

    expect(result).toBe('{"key":"val"}');
  });

  it('renders "null" when an expression evaluates to null', () => {
    const ctx = makeCtx();
    expect(interpolate('${{ null }}', ctx)).toBe('null');
  });
});

describe('evalCel', () => {
  it('returns true for a boolean equality expression that holds', () => {
    const ctx = makeCtx();

    const result = evalCel('1 == 1', ctx);

    expect(result).toBe(true);
  });

  it('returns the string value of a ctx.inputs field', () => {
    const ctx = makeCtx({ inputs: { greeting: 'hello' } });

    const result = evalCel('inputs.greeting', ctx);

    expect(result).toBe('hello');
  });

  it('returns a number result from an arithmetic expression between two context values', () => {
    // CEL numbers from a JS context are typed as double; adding an int literal (e.g. + 1)
    // triggers a type-overload error. Both operands must be doubles (i.e. both from the context).
    const ctx = makeCtx({ inputs: { count: 4, increment: 1 } });

    const result = evalCel('inputs.count + inputs.increment', ctx);

    expect(result).toBe(5);
  });

  it('adds a CEL int literal to a BigInt input and returns a BigInt', () => {
    const ctx = makeCtx({ inputs: { count: 5n } });

    const result = evalCel('inputs.count + 1', ctx);

    expect(result).toBe(6n);
  });

  it('accesses a nested value from an arbitrary context key', () => {
    const ctx = makeCtx({ scope: { iteration: 3 } });

    const result = evalCel('scope.iteration', ctx);

    expect(result).toBe(3);
  });

  it('throws EngineError wrapping a CEL EvaluationError when a context key is absent', () => {
    expect.assertions(2);
    const ctx = makeCtx();

    let thrown: EngineError | undefined;
    try {
      evalCel('scope.iteration', ctx);
    } catch (err) {
      thrown = err as EngineError;
    }

    expect(thrown?.code).toBe('ENGINE_CEL_ERROR');
    expect(thrown?.cause).toBeInstanceOf(EvaluationError);
  });
});
