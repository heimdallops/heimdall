import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { createEngineEmitter } from '../../../../../src/core/engine/emitter.ts';
import type {
  ExecutionContext,
  PlatformAdapter,
} from '../../../../../src/core/engine/nodes/base.ts';
import { ExitNode } from '../../../../../src/core/engine/nodes/exit.ts';

const makeCtx = (): ExecutionContext => ({
  inputs: {},
  vars: {},
  needs: new Map(),
  sessionDir: '/tmp/session',
});

const fakeAdapter = {} as PlatformAdapter;

describe('ExitNode', () => {
  describe('ExitNode.matches', () => {
    it('returns true when raw object has an exit key', () => {
      expect(ExitNode.matches({ id: 'e1', exit: {} })).toBe(true);
    });

    it('returns false when raw object does not have an exit key', () => {
      expect(ExitNode.matches({ id: 'e1', bash: 'echo hi' })).toBe(false);
    });

    it('returns false when raw object has a key that only starts with "exit" but is not exactly exit', () => {
      expect(ExitNode.matches({ id: 'e1', exit_code: 1 })).toBe(false);
    });
  });

  describe('ExitNode.parse', () => {
    it('returns an ExitNode with the correct id for a minimal valid input', () => {
      const node = ExitNode.parse({ id: 'e1', exit: {} });

      expect(node).toBeInstanceOf(ExitNode);
      expect(node.id).toBe('e1');
    });

    it('defaults failure to false when omitted — verified via run() on a minimal input', async () => {
      const node = ExitNode.parse({ id: 'e1', exit: {} });
      const emitter = createEngineEmitter();

      const result = await node.run({
        ctx: makeCtx(),
        adapter: fakeAdapter,
        emitter,
        signal: new AbortController().signal,
      });

      expect(result.failure).toBe(false);
    });

    it('throws a ZodError when id contains invalid characters', () => {
      expect(() => ExitNode.parse({ id: 'bad-id', exit: {} })).toThrow(ZodError);
    });

    it('throws a ZodError when the exit field is missing entirely', () => {
      expect(() => ExitNode.parse({ id: 'e1' })).toThrow(ZodError);
    });
  });

  describe('ExitNode.run', () => {
    it('resolves with status exited, the given reason, and failure: false', async () => {
      const node = ExitNode.parse({ id: 'e1', exit: { reason: 'done', failure: false } });
      const emitter = createEngineEmitter();

      const result = await node.run({
        ctx: makeCtx(),
        adapter: fakeAdapter,
        emitter,
        signal: new AbortController().signal,
      });

      expect(result).toEqual({ status: 'exited', reason: 'done', failure: false });
    });

    it('resolves with status exited and failure: true when failure is set', async () => {
      const node = ExitNode.parse({ id: 'e1', exit: { reason: 'fatal', failure: true } });
      const emitter = createEngineEmitter();

      const result = await node.run({
        ctx: makeCtx(),
        adapter: fakeAdapter,
        emitter,
        signal: new AbortController().signal,
      });

      expect(result).toEqual({ status: 'exited', reason: 'fatal', failure: true });
    });

    it('resolves with status exited and no reason when reason is omitted', async () => {
      const node = ExitNode.parse({ id: 'e1', exit: { failure: false } });
      const emitter = createEngineEmitter();

      const result = await node.run({
        ctx: makeCtx(),
        adapter: fakeAdapter,
        emitter,
        signal: new AbortController().signal,
      });

      expect(result).toEqual({ status: 'exited', failure: false });
      expect(result.reason).toBeUndefined();
    });
  });
});
