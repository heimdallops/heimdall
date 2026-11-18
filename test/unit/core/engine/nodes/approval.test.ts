import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import type {
  ApprovalRequestedEvent,
  ApprovalResult,
} from '../../../../../src/core/engine/emitter.ts';
import { createEngineEmitter } from '../../../../../src/core/engine/emitter.ts';
import { ApprovalNode } from '../../../../../src/core/engine/nodes/approval.ts';
import type { ExecutionContext, NodeRunResult } from '../../../../../src/core/engine/nodes/base.ts';
import type { BaseNode } from '../../../../../src/core/engine/nodes/base.ts';
import { collectEvents, eventOptions } from '../_events.ts';

const makeCtx = (
  inputs: Record<string, string | number | bigint | boolean> = {}
): ExecutionContext => ({
  inputs,
  vars: {},
  needs: new Map(),
  cwd: '/tmp/work',
  heimdall: { run_cwd: '/tmp/work', session_dir: '/tmp/session' },
  scopes: new Map(),
  path: [],
});

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
    emitter,
    signal: new AbortController().signal,
    ...eventOptions(),
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
        emitter,
        signal: new AbortController().signal,
        ...eventOptions(),
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
        emitter,
        signal: new AbortController().signal,
        ...eventOptions(),
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
        emitter,
        signal: new AbortController().signal,
        ...eventOptions(),
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
        emitter,
        signal: new AbortController().signal,
        ...eventOptions(),
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
        emitter,
        signal: AbortSignal.abort(),
        ...eventOptions(),
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
        emitter,
        signal: controller.signal,
        ...eventOptions(),
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
        emitter,
        signal: new AbortController().signal,
        ...eventOptions(),
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

  describe('no-listener guard', () => {
    it('rejects with NodeError when no approval_requested listener is registered', async () => {
      const emitter = createEngineEmitter(); // no listener registered
      const node = makeNode({ id: 'a1', approval: { message: 'Approve?' } });

      await expect(
        node.run({
          ctx: makeCtx(),
          emitter,
          signal: new AbortController().signal,
          ...eventOptions(),
        })
      ).rejects.toMatchObject({
        name: 'NodeError',
        code: 'ENGINE_APPROVAL_NO_LISTENER',
      });
    });
  });

  describe('approval events', () => {
    // Runs the node with a listener that records the order of emitter and publisher activity.
    const runRecording = (
      raw: Record<string, unknown>,
      signal: AbortSignal = new AbortController().signal
    ): {
      collected: ReturnType<typeof collectEvents>;
      order: string[];
      requests: ApprovalRequestedEvent[];
      runPromise: Promise<NodeRunResult>;
    } => {
      const collected = collectEvents();
      const order: string[] = [];
      const requests: ApprovalRequestedEvent[] = [];
      collected.publisher.subscribe((e) => order.push(e.type));
      const emitter = createEngineEmitter();
      emitter.on('approval_requested', (event) => {
        order.push('approval_requested');
        requests.push(event);
      });

      const runPromise = makeNode(raw).run({
        ctx: makeCtx(),
        emitter,
        signal,
        ...eventOptions(collected.publisher),
      });

      return { collected, order, requests, runPromise };
    };

    it('publishes approval.requested before emitting approval_requested', async () => {
      const { collected, order, requests, runPromise } = runRecording({
        id: 'gate',
        approval: { message: 'Ship it?', enable_feedback: true },
      });

      expect(order).toEqual(['approval.requested', 'approval_requested']);
      expect(collected.ofType('approval.requested')[0]!.data).toEqual({
        message: 'Ship it?',
        enableFeedback: true,
      });

      requests[0]!.resolve({ approved: true });
      await runPromise;
    });

    it('publishes approval.resolved with the decision and feedback', async () => {
      const { collected, requests, runPromise } = runRecording({
        id: 'gate',
        approval: { message: 'Ship it?', enable_feedback: true },
      });

      requests[0]!.resolve({ approved: false, feedback: 'add tests' });
      await runPromise;

      expect(collected.ofType('approval.resolved').map((e) => e.data)).toEqual([
        { approved: false, feedback: 'add tests' },
      ]);
    });

    it('leaves feedback out of approval.resolved when feedback is not enabled', async () => {
      const { collected, requests, runPromise } = runRecording({
        id: 'gate',
        approval: { message: 'Ship it?' },
      });

      requests[0]!.resolve({ approved: true, feedback: 'ignored' });
      await runPromise;

      expect(collected.ofType('approval.resolved')[0]!.data).toEqual({ approved: true });
    });

    it('publishes approval.resolved even when a decline exits the run', async () => {
      const { collected, requests, runPromise } = runRecording({
        id: 'gate',
        approval: { message: 'Ship it?', exit_on_no: true },
      });

      requests[0]!.resolve({ approved: false });

      await expect(runPromise).resolves.toMatchObject({ status: 'exited' });
      expect(collected.ofType('approval.resolved')[0]!.data).toEqual({ approved: false });
    });

    it('publishes no approval.resolved when the approval is cancelled', async () => {
      const controller = new AbortController();
      const { collected, runPromise } = runRecording(
        { id: 'gate', approval: { message: 'Ship it?' } },
        controller.signal
      );

      controller.abort();
      await runPromise;

      expect(collected.types()).toEqual(['approval.requested']);
    });

    it('publishes one approval.resolved when resolve is called twice', async () => {
      const { collected, requests, runPromise } = runRecording({
        id: 'gate',
        approval: { message: 'Ship it?' },
      });

      requests[0]!.resolve({ approved: true });
      expect(() => {
        requests[0]!.resolve({ approved: false });
      }).toThrow(expect.objectContaining({ code: 'ENGINE_APPROVAL_DOUBLE_RESOLVE' }));
      await runPromise;

      expect(collected.ofType('approval.resolved')).toHaveLength(1);
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
