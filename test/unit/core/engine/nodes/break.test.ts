import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { createEngineEmitter } from '../../../../../src/core/engine/emitter.ts';
import type { ExecutionContext } from '../../../../../src/core/engine/nodes/base.ts';
import { BreakNode } from '../../../../../src/core/engine/nodes/break.ts';

const makeCtx = (): ExecutionContext => ({
  inputs: {},
  vars: {},
  needs: new Map(),
  cwd: '/tmp/work',
  heimdall: { run_cwd: '/tmp/work', session_dir: '/tmp/session' },
  scopes: new Map(),
});

describe('BreakNode', () => {
  describe('BreakNode.matches', () => {
    it('returns true when raw object has a break key', () => {
      expect(BreakNode.matches({ id: 'b1', break: true })).toBe(true);
    });

    it('returns false when raw object does not have a break key', () => {
      expect(BreakNode.matches({ id: 'b1', bash: 'echo hi' })).toBe(false);
    });
  });

  describe('BreakNode.parse', () => {
    it('returns a BreakNode for valid input', () => {
      const node = BreakNode.parse({ id: 'b1', break: true });

      expect(node).toBeInstanceOf(BreakNode);
      expect(node.id).toBe('b1');
    });

    it('throws a ZodError when id contains invalid characters', () => {
      expect(() => BreakNode.parse({ id: 'bad-id', break: true })).toThrow(ZodError);
    });
  });

  describe('BreakNode.run', () => {
    it('resolves with status break', async () => {
      const node = BreakNode.parse({ id: 'b1', break: true });
      const emitter = createEngineEmitter();

      const result = await node.run({
        ctx: makeCtx(),
        emitter,
        signal: new AbortController().signal,
      });

      expect(result).toEqual({ status: 'break' });
    });
  });
});
