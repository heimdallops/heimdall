import { EventEmitter } from 'node:events';

export type NodeResult = Record<string, unknown>;

export interface NodeStartedEvent {
  nodeId: string;
  nodeName: string;
}

export interface NodeCompletedEvent {
  nodeId: string;
  nodeName: string;
  result: NodeResult;
}

export interface NodeSkippedEvent {
  nodeId: string;
  nodeName: string;
}

export interface NodeFailedEvent {
  nodeId: string;
  nodeName: string;
  error: unknown;
}

export interface WorkflowExitedEvent {
  reason?: string;
  failure: boolean;
}

export interface WorkflowCompletedEvent {
  success: boolean;
}

export interface WorktreeDirtyEvent {
  worktreePath: string;
}

export interface ApprovalResult {
  approved: boolean;
  feedback?: string;
}

export interface ApprovalRequestedEvent {
  nodeId: string;
  nodeName: string;
  message: string;
  enableFeedback: boolean;
  resolve: (result: ApprovalResult) => void;
}

export interface EngineEventMap {
  node_started: [NodeStartedEvent];
  node_completed: [NodeCompletedEvent];
  node_skipped: [NodeSkippedEvent];
  node_failed: [NodeFailedEvent];
  workflow_exited: [WorkflowExitedEvent];
  workflow_completed: [WorkflowCompletedEvent];
  worktree_dirty: [WorktreeDirtyEvent];
  approval_requested: [ApprovalRequestedEvent];
}

export interface EngineEmitter extends EventEmitter {
  on<K extends keyof EngineEventMap>(
    event: K,
    listener: (...args: EngineEventMap[K]) => void
  ): this;
  once<K extends keyof EngineEventMap>(
    event: K,
    listener: (...args: EngineEventMap[K]) => void
  ): this;
  addListener<K extends keyof EngineEventMap>(
    event: K,
    listener: (...args: EngineEventMap[K]) => void
  ): this;
  prependListener<K extends keyof EngineEventMap>(
    event: K,
    listener: (...args: EngineEventMap[K]) => void
  ): this;
  prependOnceListener<K extends keyof EngineEventMap>(
    event: K,
    listener: (...args: EngineEventMap[K]) => void
  ): this;
  removeListener<K extends keyof EngineEventMap>(
    event: K,
    listener: (...args: EngineEventMap[K]) => void
  ): this;
  off<K extends keyof EngineEventMap>(
    event: K,
    listener: (...args: EngineEventMap[K]) => void
  ): this;
  emit<K extends keyof EngineEventMap>(event: K, ...args: EngineEventMap[K]): boolean;
}

export const createEngineEmitter = (): EngineEmitter => new EventEmitter() as EngineEmitter;
