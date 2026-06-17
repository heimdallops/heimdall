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
  NodeRunFailed,
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

  const runPromise = node.run({
    ctx,
    adapter: fakeAdapter,
    emitter,
    signal: new AbortController().signal,
  });

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
      await node.run({
        ctx: makeCtx(),
        adapter: fakeAdapter,
        emitter,
        signal: new AbortController().signal,
      });

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
        signal: new AbortController().signal,
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
      await node.run({
        ctx: makeCtx(),
        adapter: fakeAdapter,
        emitter,
        signal: new AbortController().signal,
      });

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
      await node.run({
        ctx: makeCtx(),
        adapter: fakeAdapter,
        emitter,
        signal: new AbortController().signal,
      });

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

    it('returns status exited when enable_feedback: true but feedback is an empty string', async () => {
      const node = makeNode({
        id: 'a1',
        approval: { message: 'Approve?', exit_on_no: true, enable_feedback: true },
      });
      const result = await runWithResolve(node, makeCtx(), { approved: false, feedback: '' });

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

    it('does not include feedback key when enable_feedback: true but feedback is an empty string', async () => {
      const node = makeNode({
        id: 'a1',
        approval: { message: 'Approve?', enable_feedback: true },
      });
      const result = await runWithResolve(node, makeCtx(), { approved: true, feedback: '' });

      expect(result).toEqual({ status: 'completed', result: { approved: true } });
    });
  });

  describe('abort signal handling', () => {
    it('resolves with failed/ENGINE_NODE_CANCELLED without emitting approval_requested when signal is already aborted', async () => {
      const emitter = createEngineEmitter();
      const requestedEvents: ApprovalRequestedEvent[] = [];
      emitter.on('approval_requested', (e) => requestedEvents.push(e));

      const node = makeNode({ id: 'a1', approval: { message: 'Approve?' } });
      const result = await node.run({
        ctx: makeCtx(),
        adapter: fakeAdapter,
        emitter,
        signal: AbortSignal.abort(),
      });

      expect(result.status).toBe('failed');
      expect((result as { status: 'failed'; error: { code: string } }).error.code).toBe(
        'ENGINE_NODE_CANCELLED'
      );
      expect(requestedEvents).toHaveLength(0);
    });

    it('resolves with failed/ENGINE_NODE_CANCELLED when signal aborts while awaiting approval', async () => {
      const emitter = createEngineEmitter();
      const requestedEvents: ApprovalRequestedEvent[] = [];

      emitter.on('approval_requested', (e) => {
        requestedEvents.push(e);
      });

      const controller = new AbortController();
      const node = makeNode({ id: 'a1', approval: { message: 'Approve?' } });
      const runPromise = node.run({
        ctx: makeCtx(),
        adapter: fakeAdapter,
        emitter,
        signal: controller.signal,
      });

      expect(requestedEvents).toHaveLength(1);

      controller.abort();

      const result = await runPromise;

      expect(result.status).toBe('failed');
      expect((result as { status: 'failed'; error: { code: string } }).error.code).toBe(
        'ENGINE_NODE_CANCELLED'
      );
      expect(requestedEvents).toHaveLength(1);
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
      const runPromise = node.run({
        ctx: makeCtx(),
        adapter: fakeAdapter,
        emitter,
        signal: new AbortController().signal,
      });

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

  describe('reject path', () => {
    it('resolves with failed/ENGINE_APPROVAL_PROMPT_ERROR when the listener rejects', async () => {
      const emitter = createEngineEmitter();
      let capturedReject: ((error: unknown) => void) | undefined;

      emitter.on('approval_requested', (event: ApprovalRequestedEvent) => {
        capturedReject = event.reject;
      });

      const node = makeNode({ id: 'a1', approval: { message: 'Approve?' } });
      const runPromise = node.run({
        ctx: makeCtx(),
        adapter: fakeAdapter,
        emitter,
        signal: new AbortController().signal,
      });

      if (!capturedReject) {
        throw new Error(
          'approval_requested was not emitted synchronously — capturedReject not populated'
        );
      }

      const cause = new Error('tty closed');
      capturedReject(cause);

      const result = (await runPromise) as NodeRunFailed;
      expect(result.status).toBe('failed');
      expect(result.error).toMatchObject({
        name: 'NodeError',
        code: 'ENGINE_APPROVAL_PROMPT_ERROR',
        cause,
      });
    });

    it('throws the double-resolve guard when reject is called after settling', async () => {
      const emitter = createEngineEmitter();
      let capturedResolve: ((result: ApprovalResult) => void) | undefined;
      let capturedReject: ((error: unknown) => void) | undefined;

      emitter.on('approval_requested', (event: ApprovalRequestedEvent) => {
        capturedResolve = event.resolve;
        capturedReject = event.reject;
      });

      const node = makeNode({ id: 'a1', approval: { message: 'Approve?' } });
      const runPromise = node.run({
        ctx: makeCtx(),
        adapter: fakeAdapter,
        emitter,
        signal: new AbortController().signal,
      });

      if (!capturedResolve || !capturedReject) {
        throw new Error('approval_requested was not emitted synchronously');
      }

      capturedResolve({ approved: true });

      expect(() => {
        capturedReject!(new Error('late'));
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
        node.run({
          ctx: makeCtx(),
          adapter: fakeAdapter,
          emitter,
          signal: new AbortController().signal,
        })
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
    it('throws a ZodError identifying the missing approval.message field', () => {
      let caught: unknown;
      try {
        ApprovalNode.parse({ id: 'a1', approval: {} });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ZodError);
      const paths = (caught as ZodError).issues.map((i) => i.path.join('.'));
      expect(paths).toContain('approval.message');
    });

    it('throws a ZodError identifying the invalid id when id contains invalid characters', () => {
      let caught: unknown;
      try {
        ApprovalNode.parse({ id: 'bad-id', approval: { message: 'Approve?' } });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ZodError);
      const idIssue = (caught as ZodError).issues.find((i) => i.path.includes('id'));
      expect(idIssue).toBeDefined();
      expect(idIssue?.message).toMatch(/Node id must match/);
    });
  });
});
