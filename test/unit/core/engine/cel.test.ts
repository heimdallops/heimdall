import { EvaluationError } from '@marcbachmann/cel-js';
import { describe, expect, it } from 'vitest';

import { evalCel, interpolate } from '../../../../src/core/engine/cel.ts';
import type { EngineError } from '../../../../src/core/engine/errors.ts';

type CelContext = Record<string, unknown>;

const makeCtx = (overrides?: Partial<CelContext>): CelContext => ({
  inputs: {},
  vars: {},
  heimdall: { run_cwd: '/tmp/work', session_dir: '/tmp/session' },
  self: { needs: new Map() },
  scopes: new Map(),
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
    const ctx = makeCtx({ self: { needs: new Map([['step', { key: 'val' }]]) } });

    const result = interpolate('${{ self.needs.step }}', ctx);

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

  it('accesses a scope attribute through the id of the enclosing node', () => {
    const ctx = makeCtx({ scopes: new Map([['ci', { index: 3 }]]) });

    const result = evalCel('scopes.ci.index', ctx);

    expect(result).toBe(3);
  });

  // cwd is engine-only: BashNode forwards it to the process, and it is never bound as a root.
  it.each(['scopes.ci.index', 'cwd'])(
    'throws EngineError wrapping a CEL EvaluationError for the unresolvable reference %s',
    (expr) => {
      expect.assertions(2);
      const ctx = makeCtx();

      let thrown: EngineError | undefined;
      try {
        evalCel(expr, ctx);
      } catch (err) {
        thrown = err as EngineError;
      }

      expect(thrown?.code).toBe('ENGINE_CEL_ERROR');
      expect(thrown?.cause).toBeInstanceOf(EvaluationError);
    }
  );
});

describe('sanitize (via evalCel / interpolate)', () => {
  describe('Map → plain object conversion', () => {
    it('exposes Map string keys as accessible fields in CEL', () => {
      const ctx = makeCtx({ self: { needs: new Map([['build', { exitCode: 0 }]]) } });

      const result = evalCel('self.needs.build.exitCode', ctx);

      expect(result).toBe(0);
    });

    it('makes a Map value interpolatable as a nested field reference', () => {
      const ctx = makeCtx({ self: { needs: new Map([['lint', { passed: true }]]) } });

      const result = interpolate('${{ self.needs.lint.passed }}', ctx);

      expect(result).toBe('true');
    });

    it('drops non-string keys from a Map, preserving string keys', () => {
      expect.assertions(3);
      const mapWithMixedKeys = new Map<unknown, unknown>([
        [42, 'should-be-gone'],
        ['safe', 'kept'],
      ]);
      const ctx = makeCtx({ data: mapWithMixedKeys });

      expect(evalCel('data.safe', ctx)).toBe('kept');

      // Directly proves numeric key 42 was not coerced to string "42" and retained.
      let thrownNumeric: EngineError | undefined;
      try {
        evalCel("data['42']", ctx);
      } catch (err) {
        thrownNumeric = err as EngineError;
      }

      expect(thrownNumeric?.code).toBe('ENGINE_CEL_ERROR');
      expect(thrownNumeric?.cause).toBeInstanceOf(EvaluationError);
    });

    it('a Map reused under two keys produces independent sanitized copies of each', () => {
      const sharedMap = new Map([['value', 'present']]);
      const ctx = makeCtx({ first: sharedMap, second: sharedMap });

      expect(evalCel('first.value', ctx)).toBe('present');
      expect(evalCel('second.value', ctx)).toBe('present');
    });
  });

  describe('recursive sanitization of nested plain objects', () => {
    it('strips a blocked key nested inside a plain object so it is not accessible in CEL', () => {
      expect.assertions(2);
      // Verifies blocked-key stripping recurses into nested objects, not just the top level.
      const ctx = makeCtx({ scopes: { ci: { constructor: 'should-be-gone', safe: 'ok' } } });

      const safeResult = evalCel('scopes.ci.safe', ctx);
      expect(safeResult).toBe('ok');

      let thrown: EngineError | undefined;
      try {
        evalCel('scopes.ci.constructor', ctx);
      } catch (err) {
        thrown = err as EngineError;
      }

      expect(thrown?.code).toBe('ENGINE_CEL_ERROR');
    });

    it('strips a blocked key nested two levels deep so it is not accessible in CEL', () => {
      expect.assertions(2);
      const ctx = makeCtx({ outer: { inner: { prototype: 'danger', safe: 'ok' } } });

      expect(evalCel('outer.inner.safe', ctx)).toBe('ok');

      let thrown: EngineError | undefined;
      try {
        evalCel('outer.inner.prototype', ctx);
      } catch (err) {
        thrown = err as EngineError;
      }

      expect(thrown?.code).toBe('ENGINE_CEL_ERROR');
    });
  });

  describe('top-level blocked keys', () => {
    it('drops blocked keys from a Map so they are not accessible in CEL', () => {
      expect.assertions(2);
      const ctx = makeCtx({
        data: new Map<string, unknown>([
          ['__proto__', 'danger'],
          ['safe', 'ok'],
        ]),
      });

      // Non-blocked keys survive sanitization.
      expect(evalCel('data.safe', ctx)).toBe('ok');

      // __proto__ is stripped by sanitize before CEL sees it, so accessing it via
      // bracket notation raises an EvaluationError ("No such key: __proto__").
      let thrown: EngineError | undefined;
      try {
        evalCel("data['__proto__']", ctx);
      } catch (err) {
        thrown = err as EngineError;
      }

      expect(thrown?.code).toBe('ENGINE_CEL_ERROR');
    });

    it('strips a top-level blocked key so it is not accessible in CEL', () => {
      expect.assertions(2);
      const ctx: Record<string, unknown> = {
        inputs: {},
        vars: {},
        heimdall: { run_cwd: '/tmp/work', session_dir: '/tmp/session' },
        self: { needs: new Map() },
        scopes: new Map(),
        constructor: 'blocked',
      };

      // Safe keys survive sanitization.
      expect(evalCel('heimdall.run_cwd', ctx)).toBe('/tmp/work');

      // The blocked key is stripped; accessing it throws.
      let thrown: EngineError | undefined;
      try {
        evalCel('constructor', ctx);
      } catch (err) {
        thrown = err as EngineError;
      }

      expect(thrown?.code).toBe('ENGINE_CEL_ERROR');
    });

    it('does not expose Object.prototype properties as top-level CEL variables', () => {
      expect.assertions(2);
      // Object.create(null) in sanitize severs the Object.prototype chain; BLOCKED_KEYS is not what prevents prototype-pollution here.
      const ctx = makeCtx({ safe: 'ok' });

      // Own keys still work after sanitization.
      expect(evalCel('safe', ctx)).toBe('ok');

      let thrown: EngineError | undefined;
      try {
        evalCel('toString', ctx);
      } catch (err) {
        thrown = err as EngineError;
      }

      expect(thrown?.code).toBe('ENGINE_CEL_ERROR');
    });
  });

  describe('array support', () => {
    it('preserves an array of strings so individual elements are accessible by index in CEL', () => {
      const ctx = makeCtx({ tags: ['alpha', 'beta', 'gamma'] });

      const result = evalCel('tags[1]', ctx);

      expect(result).toBe('beta');
    });

    it("preserves an array of plain objects so each element's fields are accessible in CEL", () => {
      const ctx = makeCtx({ steps: [{ name: 'build' }, { name: 'test' }] });

      const result = evalCel('steps[0].name', ctx);

      expect(result).toBe('build');
    });

    it('converts Maps inside an array to plain objects so their fields are accessible in CEL', () => {
      const ctx = makeCtx({
        results: [new Map([['status', 'ok']]), new Map([['status', 'fail']])],
      });

      const firstStatus = evalCel('results[0].status', ctx);
      const secondStatus = evalCel('results[1].status', ctx);

      expect(firstStatus).toBe('ok');
      expect(secondStatus).toBe('fail');
    });

    it('strips blocked keys from plain objects inside an array', () => {
      expect.assertions(2);
      const ctx = makeCtx({ items: [{ constructor: 'danger', safe: 'ok' }] });

      expect(evalCel('items[0].safe', ctx)).toBe('ok');

      let thrown: EngineError | undefined;
      try {
        evalCel('items[0].constructor', ctx);
      } catch (err) {
        thrown = err as EngineError;
      }

      expect(thrown?.code).toBe('ENGINE_CEL_ERROR');
    });

    it('preserves null elements inside arrays', () => {
      const ctx = makeCtx({ data: [null, 'ok'] });

      expect(evalCel('data[1]', ctx)).toBe('ok');
      // null must not be passed to visited.has(); confirm no throw.
      expect(() => evalCel('data[0]', ctx)).not.toThrow();
    });
  });

  describe('cycle detection', () => {
    it('does not stack-overflow when a context value contains a circular object reference', () => {
      expect.assertions(2);
      const data: Record<string, unknown> = { safe: 'ok' };
      data['self'] = data; // circular
      const ctx = makeCtx({ data });

      // sanitize recurses eagerly; without cycle detection this would be a RangeError.
      expect(evalCel('data.safe', ctx)).toBe('ok');

      // The circular slot is an ancestor on the current stack, so it is replaced with {}.
      const cycleSlotSize = evalCel('data.self.size()', ctx);
      expect(cycleSlotSize).toBe(0n);
    });

    it('replaces a circular array slot with an empty object so no field is accessible and no stack overflow occurs', () => {
      expect.assertions(2);
      const circular: unknown[] = ['first'];
      circular.push(circular);
      const ctx = makeCtx({ arr: circular });

      // sanitize recurses eagerly; without cycle detection this would be a RangeError.
      const firstElement = evalCel('arr[0]', ctx);
      expect(firstElement).toBe('first');

      // The circular slot at index 1 is replaced with {}; it should have no accessible fields.
      const cycleSlotSize = evalCel('arr[1].size()', ctx);
      expect(cycleSlotSize).toBe(0n);
    });

    it('a Map reused as two array elements produces independent sanitized copies of each', () => {
      const sharedMap = new Map([['key', 'val']]);
      const ctx = makeCtx({ items: [sharedMap, sharedMap] });

      expect(evalCel('items[0].key', ctx)).toBe('val');
      expect(evalCel('items[1].key', ctx)).toBe('val');
    });
  });
});
