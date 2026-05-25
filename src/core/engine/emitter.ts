import { EventEmitter } from 'node:events';

export type NodeResult = Record<string, unknown>;

export interface NodeStartedEvent {
  nodeId: string;
}

export interface NodeCompletedEvent {
  nodeId: string;
  result: NodeResult;
}

export interface NodeSkippedEvent {
  nodeId: string;
}

export interface NodeFailedEvent {
  nodeId: string;
  error: unknown;
}

export interface WorkflowExitedEvent {
  reason: string | undefined;
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
  on(event: string, listener: (...args: unknown[]) => void): this;
  once<K extends keyof EngineEventMap>(
    event: K,
    listener: (...args: EngineEventMap[K]) => void
  ): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  addListener<K extends keyof EngineEventMap>(
    event: K,
    listener: (...args: EngineEventMap[K]) => void
  ): this;
  addListener(event: string, listener: (...args: unknown[]) => void): this;
  prependListener<K extends keyof EngineEventMap>(
    event: K,
    listener: (...args: EngineEventMap[K]) => void
  ): this;
  prependListener(event: string, listener: (...args: unknown[]) => void): this;
  prependOnceListener<K extends keyof EngineEventMap>(
    event: K,
    listener: (...args: EngineEventMap[K]) => void
  ): this;
  prependOnceListener(event: string, listener: (...args: unknown[]) => void): this;
  removeListener<K extends keyof EngineEventMap>(
    event: K,
    listener: (...args: EngineEventMap[K]) => void
  ): this;
  removeListener(event: string, listener: (...args: unknown[]) => void): this;
  off<K extends keyof EngineEventMap>(
    event: K,
    listener: (...args: EngineEventMap[K]) => void
  ): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
  emit<K extends keyof EngineEventMap>(event: K, ...args: EngineEventMap[K]): boolean;
  emit(event: string, ...args: unknown[]): boolean;
}

export const createEngineEmitter = (): EngineEmitter => new EventEmitter() as EngineEmitter;
