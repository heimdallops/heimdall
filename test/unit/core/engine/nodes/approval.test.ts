import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import type {
  ApprovalRequestedEvent,
  ApprovalResult,
} from '../../../../../src/core/engine/emitter.ts';
import { createEngineEmitter } from '../../../../../src/core/engine/emitter.ts';
import { ApprovalNode } from '../../../../../src/core/engine/nodes/approval.ts';
import type {
  ExecutionContext,
  NodeRunResult,
  PlatformAdapter,
} from '../../../../../src/core/engine/nodes/base.ts';
import type { BaseNode } from '../../../../../src/core/engine/nodes/base.ts';

const makeCtx = (
  inputs: Record<string, string | number | bigint | boolean> = {}
): ExecutionContext => ({
  inputs,
  vars: {},
  needs: new Map(),
  sessionDir: '/tmp/session',
});

const fakeAdapter = {} as PlatformAdapter;

const makeNode = (raw: Record<string, unknown>): BaseNode<NodeRunResult> => ApprovalNode.parse(raw);

const runWithResolve = (
  node: BaseNode<NodeRunResult>,
  ctx: ExecutionContext,
  resolveWith: ApprovalResult
): Promise<NodeRunResult> => {
  const emitter = createEngineEmitter();
  let capturedResolve: ((result: ApprovalResult) => void) | undefined;

  emitter.on('approval_requested', (event: ApprovalRequestedEvent) => {
    capturedResolve = event.resolve;
  });

  const runPromise = node.run({ ctx, adapter: fakeAdapter, emitter });

  if (!capturedResolve) {
    throw new Error(
      'approval_requested was not emitted synchronously — runWithResolve helper assumption violated'
    );
  }

  capturedResolve(resolveWith);

  return runPromise;
};

describe('ApprovalNode', () => {
  describe('approval_requested event', () => {
    it('emits approval_requested with the node id', async () => {
      const emitter = createEngineEmitter();
      let capturedNodeId: string | undefined;

      emitter.on('approval_requested', (event: ApprovalRequestedEvent) => {
        capturedNodeId = event.nodeId;
        event.resolve({ approved: true });
      });

      const node = makeNode({ id: 'approval1', approval: { message: 'Please approve' } });
      await node.run({ ctx: makeCtx(), adapter: fakeAdapter, emitter });

      expect(capturedNodeId).toBe('approval1');
    });

    it('emits approval_requested with the interpolated message', async () => {
      const emitter = createEngineEmitter();
      let capturedMessage: string | undefined;

      emitter.on('approval_requested', (event: ApprovalRequestedEvent) => {
        capturedMessage = event.message;
        event.resolve({ approved: true });
      });

      const node = makeNode({
        id: 'a1',
        approval: { message: 'Hello ${{ inputs.name }}' },
      });
      await node.run({
        ctx: makeCtx({ name: 'World' }),
        adapter: fakeAdapter,
        emitter,
      });

      expect(capturedMessage).toBe('Hello World');
    });

    it('emits enableFeedback: true when enable_feedback is set', async () => {
      const emitter = createEngineEmitter();
      let capturedEnableFeedback: boolean | undefined;

      emitter.on('approval_requested', (event: ApprovalRequestedEvent) => {
        capturedEnableFeedback = event.enableFeedback;
        event.resolve({ approved: true });
      });

      const node = makeNode({
        id: 'a1',
        approval: { message: 'Approve?', enable_feedback: true },
      });
      await node.run({ ctx: makeCtx(), adapter: fakeAdapter, emitter });

      expect(capturedEnableFeedback).toBe(true);
    });

    it('emits enableFeedback: false when enable_feedback is not set', async () => {
      const emitter = createEngineEmitter();
      let capturedEnableFeedback: boolean | undefined;

      emitter.on('approval_requested', (event: ApprovalRequestedEvent) => {
        capturedEnableFeedback = event.enableFeedback;
        event.resolve({ approved: true });
      });

      const node = makeNode({ id: 'a1', approval: { message: 'Approve?' } });
      await node.run({ ctx: makeCtx(), adapter: fakeAdapter, emitter });

      expect(capturedEnableFeedback).toBe(false);
    });
  });

  describe('approved: true', () => {
    it('returns status completed with approved: true', async () => {
      const node = makeNode({ id: 'a1', approval: { message: 'Approve?' } });
      const result = await runWithResolve(node, makeCtx(), { approved: true });

      expect(result).toEqual({ status: 'completed', result: { approved: true } });
    });
  });

  describe('approved: false with exit_on_no: false (default)', () => {
    it('returns status completed with approved: false', async () => {
      const node = makeNode({ id: 'a1', approval: { message: 'Approve?' } });
      const result = await runWithResolve(node, makeCtx(), { approved: false });

      expect(result).toEqual({ status: 'completed', result: { approved: false } });
    });
  });

  describe('approved: false with exit_on_no: true', () => {
    it('returns status exited with reason "Approval declined" and failure: false', async () => {
      const node = makeNode({
        id: 'a1',
        approval: { message: 'Approve?', exit_on_no: true },
      });
      const result = await runWithResolve(node, makeCtx(), { approved: false });

      expect(result).toEqual({
        status: 'exited',
        reason: 'Approval declined',
        failure: false,
      });
    });

    it('does not exit when approved: true even if exit_on_no is set', async () => {
      const node = makeNode({
        id: 'a1',
        approval: { message: 'Approve?', exit_on_no: true },
      });
      const result = await runWithResolve(node, makeCtx(), { approved: true });

      expect(result).toEqual({ status: 'completed', result: { approved: true } });
    });

    it('returns status completed with approved: false when enable_feedback: true and feedback is present', async () => {
      const node = makeNode({
        id: 'a1',
        approval: { message: 'Approve?', exit_on_no: true, enable_feedback: true },
      });
      const result = await runWithResolve(node, makeCtx(), {
        approved: false,
        feedback: 'Needs more work',
      });

      expect(result).toEqual({
        status: 'completed',
        result: { approved: false, feedback: 'Needs more work' },
      });
    });

    it('returns status exited when enable_feedback: true but no feedback is provided', async () => {
      const node = makeNode({
        id: 'a1',
        approval: { message: 'Approve?', exit_on_no: true, enable_feedback: true },
      });
      const result = await runWithResolve(node, makeCtx(), { approved: false });

      expect(result).toEqual({
        status: 'exited',
        reason: 'Approval declined',
        failure: false,
      });
    });

    it('returns status exited when feedback is provided but enable_feedback: false', async () => {
      const node = makeNode({
        id: 'a1',
        approval: { message: 'Approve?', exit_on_no: true },
      });
      const result = await runWithResolve(node, makeCtx(), {
        approved: false,
        feedback: 'Some guidance',
      });

      expect(result).toEqual({
        status: 'exited',
        reason: 'Approval declined',
        failure: false,
      });
    });
  });

  describe('feedback handling', () => {
    it('includes feedback in result when enable_feedback: true and feedback is provided', async () => {
      const node = makeNode({
        id: 'a1',
        approval: { message: 'Approve?', enable_feedback: true },
      });
      const result = await runWithResolve(node, makeCtx(), {
        approved: true,
        feedback: 'Looks good',
      });

      expect(result).toEqual({
        status: 'completed',
        result: { approved: true, feedback: 'Looks good' },
      });
    });

    it('does not include feedback when enable_feedback: false even if feedback is provided', async () => {
      const node = makeNode({ id: 'a1', approval: { message: 'Approve?' } });
      const result = await runWithResolve(node, makeCtx(), {
        approved: true,
        feedback: 'Should be ignored',
      });

      expect(result).toEqual({ status: 'completed', result: { approved: true } });
    });

    it('does not include feedback key when enable_feedback: true but no feedback given', async () => {
      const node = makeNode({
        id: 'a1',
        approval: { message: 'Approve?', enable_feedback: true },
      });
      const result = await runWithResolve(node, makeCtx(), { approved: true });

      expect(result).toEqual({ status: 'completed', result: { approved: true } });
    });
  });

  describe('double-resolve guard', () => {
    it('throws NodeError on the second call and resolves the Promise with the first result', async () => {
      const emitter = createEngineEmitter();
      let capturedResolve: ((result: ApprovalResult) => void) | undefined;

      emitter.on('approval_requested', (event: ApprovalRequestedEvent) => {
        capturedResolve = event.resolve;
      });

      const node = makeNode({ id: 'a1', approval: { message: 'Approve?' } });
      const runPromise = node.run({ ctx: makeCtx(), adapter: fakeAdapter, emitter });

      if (!capturedResolve) {
        throw new Error(
          'approval_requested was not emitted synchronously — capturedResolve not populated'
        );
      }

      const resolveOnce = capturedResolve;

      resolveOnce({ approved: true }); // first call — settles the Promise

      expect(() => {
        resolveOnce({ approved: false });
      }).toThrow(
        expect.objectContaining({ name: 'NodeError', code: 'ENGINE_APPROVAL_DOUBLE_RESOLVE' })
      );

      await expect(runPromise).resolves.toEqual({
        status: 'completed',
        result: { approved: true },
      });
    });
  });

  describe('no-listener guard', () => {
    it('rejects with NodeError when no approval_requested listener is registered', async () => {
      const emitter = createEngineEmitter(); // no listener registered
      const node = makeNode({ id: 'a1', approval: { message: 'Approve?' } });

      await expect(
        node.run({ ctx: makeCtx(), adapter: fakeAdapter, emitter })
      ).rejects.toMatchObject({
        name: 'NodeError',
        code: 'ENGINE_APPROVAL_NO_LISTENER',
      });
    });
  });

  describe('ApprovalNode.matches', () => {
    it('returns true when raw object has an approval key', () => {
      expect(ApprovalNode.matches({ id: 'a1', approval: { message: 'hi' } })).toBe(true);
    });

    it('returns false when raw object does not have an approval key', () => {
      expect(ApprovalNode.matches({ id: 'a1', bash: 'echo hi' })).toBe(false);
    });
  });

  describe('ApprovalNode.parse', () => {
    it('throws a ZodError when required approval.message is missing', () => {
      expect(() => ApprovalNode.parse({ id: 'a1', approval: {} })).toThrow(ZodError);
    });

    it('throws a ZodError when id contains invalid characters', () => {
      expect(() => ApprovalNode.parse({ id: 'bad-id', approval: { message: 'Approve?' } })).toThrow(
        ZodError
      );
    });
  });
});
