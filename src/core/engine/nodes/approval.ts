import { interpolate } from '../cel.ts';
import type { ApprovalResult } from '../emitter.ts';
import { EngineError } from '../errors.ts';
import { ApprovalNodeSchema } from '../schema.ts';
import type { BaseNodeData, NodeRunCompleted, NodeRunExited, NodeRunOptions } from './base.ts';
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

export class ApprovalNode extends BaseNode<NodeRunCompleted | NodeRunExited> {
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
      exitOnNo: data.approval.exit_on_no ?? false,
      enableFeedback: data.approval.enable_feedback ?? false,
    });
  }

  public constructor(data: ApprovalNodeData) {
    super(data);
    this.message = data.message;
    this.exitOnNo = data.exitOnNo;
    this.enableFeedback = data.enableFeedback;
  }

  public override run(options: NodeRunOptions): Promise<NodeRunCompleted | NodeRunExited> {
    const { ctx, emitter } = options;

    const interpolatedMessage = interpolate(
      this.message,
      ctx as unknown as Record<string, unknown>
    );

    return new Promise<NodeRunCompleted | NodeRunExited>((resolve, reject) => {
      if (emitter.listenerCount('approval_requested') === 0) {
        reject(
          new EngineError(
            `Approval node "${this.id}" emitted approval_requested but no listener is registered`,
            'ENGINE_APPROVAL_NO_LISTENER'
          )
        );

        return;
      }

      let resolved = false;

      const guardedResolve = (approvalResult: ApprovalResult): void => {
        if (resolved) {
          return;
        }

        resolved = true;

        if (this.exitOnNo && !approvalResult.approved) {
          resolve({ status: 'exited', reason: 'Approval declined', failure: false });

          return;
        }

        const result: ApprovalNodeResult = {
          approved: approvalResult.approved,
          ...(this.enableFeedback && approvalResult.feedback
            ? { feedback: approvalResult.feedback }
            : {}),
        };

        resolve({ status: 'completed', result });
      };

      emitter.emit('approval_requested', {
        nodeId: this.id,
        message: interpolatedMessage,
        enableFeedback: this.enableFeedback,
        resolve: guardedResolve,
      });
    });
  }
}

nodeRegistry.register(ApprovalNode);
