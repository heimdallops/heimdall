import { interpolate } from '../cel.ts';
import type { ApprovalResult } from '../emitter.ts';
import { NodeError } from '../errors.ts';
import { ApprovalNodeSchema } from '../schema.ts';
import type {
  BaseNodeData,
  NodeRunCompleted,
  NodeRunExited,
  NodeRunFailed,
  NodeRunOptions,
} from './base.ts';
import { BaseNode } from './base.ts';
import { nodeRegistry } from './registry.ts';

interface ApprovalNodeResult extends Record<string, unknown> {
  approved: boolean;
  feedback?: string;
}

interface ApprovalNodeData extends BaseNodeData {
  message: string;
  exitOnNo: boolean;
  enableFeedback: boolean;
}

export class ApprovalNode extends BaseNode<NodeRunCompleted | NodeRunExited | NodeRunFailed> {
  private readonly message: string;
  private readonly exitOnNo: boolean;
  private readonly enableFeedback: boolean;

  public static matches(raw: Record<string, unknown>): boolean {
    return 'approval' in raw;
  }

  public static parse(raw: Record<string, unknown>): ApprovalNode {
    const data = ApprovalNodeSchema.parse(raw);

    return new ApprovalNode({
      id: data.id,
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.depends_on !== undefined ? { depends_on: data.depends_on } : {}),
      ...(data.if !== undefined ? { if: data.if } : {}),
      ...(data.timeout !== undefined ? { timeout: data.timeout } : {}),
      ...(data.retries !== undefined ? { retries: data.retries } : {}),
      message: data.approval.message,
      exitOnNo: data.approval.exit_on_no,
      enableFeedback: data.approval.enable_feedback,
    });
  }

  public constructor(data: ApprovalNodeData) {
    super(data);
    this.message = data.message;
    this.exitOnNo = data.exitOnNo;
    this.enableFeedback = data.enableFeedback;
  }

  public override async run(
    options: NodeRunOptions
  ): Promise<NodeRunCompleted | NodeRunExited | NodeRunFailed> {
    const { ctx, emitter, signal } = options;

    let interpolatedMessage: string;
    try {
      // interpolate is CEL-agnostic and accepts any Record;
      // ExecutionContext satisfies this shape at runtime.
      interpolatedMessage = interpolate(this.message, ctx as unknown as Record<string, unknown>);
    } catch (err) {
      throw new NodeError(
        'Failed to interpolate approval message',
        'ENGINE_APPROVAL_INTERPOLATION_ERROR',
        this.id,
        { nodeName: this.name, cause: err }
      );
    }

    if (emitter.listenerCount('approval_requested') === 0) {
      throw new NodeError(
        'Approval node emitted approval_requested but no listener is registered',
        'ENGINE_APPROVAL_NO_LISTENER',
        this.id,
        { nodeName: this.name }
      );
    }

    if (signal.aborted) {
      return this.cancelledResult();
    }

    return await new Promise<NodeRunCompleted | NodeRunExited | NodeRunFailed>((resolve) => {
      let resolved = false;

      const onAbort = (): void => {
        if (resolved) {
          return;
        }

        resolved = true;
        resolve(this.cancelledResult());
      };

      const settle = (value: NodeRunCompleted | NodeRunExited | NodeRunFailed): void => {
        resolved = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };

      const guardedReject = (error: unknown): void => {
        if (resolved) {
          throw new NodeError(
            'Approval node resolve called more than once',
            'ENGINE_APPROVAL_DOUBLE_RESOLVE',
            this.id,
            { nodeName: this.name }
          );
        }

        settle({
          status: 'failed',
          error: new NodeError(
            'Approval could not be collected',
            'ENGINE_APPROVAL_PROMPT_ERROR',
            this.id,
            { nodeName: this.name, cause: error }
          ),
        });
      };

      const guardedResolve = (approvalResult: ApprovalResult): void => {
        if (resolved) {
          throw new NodeError(
            'Approval node resolve called more than once',
            'ENGINE_APPROVAL_DOUBLE_RESOLVE',
            this.id,
            { nodeName: this.name }
          );
        }

        // Only suppress early exit when feedback is both enabled and provided — the caller can't act on it otherwise.
        if (
          this.exitOnNo &&
          !approvalResult.approved &&
          !(this.enableFeedback && approvalResult.feedback)
        ) {
          settle({ status: 'exited', reason: 'Approval declined', failure: false });

          return;
        }

        const result: ApprovalNodeResult = {
          approved: approvalResult.approved,
          ...(this.enableFeedback && approvalResult.feedback
            ? { feedback: approvalResult.feedback }
            : {}),
        };

        settle({ status: 'completed', result });
      };

      signal.addEventListener('abort', onAbort, { once: true });

      emitter.emit('approval_requested', {
        nodeId: this.id,
        nodeName: this.displayName(),
        message: interpolatedMessage,
        enableFeedback: this.enableFeedback,
        resolve: guardedResolve,
        reject: guardedReject,
      });
    });
  }

  private cancelledResult(): NodeRunFailed {
    return {
      status: 'failed',
      error: new NodeError('Approval cancelled', 'ENGINE_NODE_CANCELLED', this.id, {
        nodeName: this.name,
      }),
    };
  }
}

nodeRegistry.register(ApprovalNode);
