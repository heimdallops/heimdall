import { EventEmitter } from 'node:events';

export type NodeResult = Record<string, unknown>;

export interface WorktreeDirtyEvent {
  worktreePath: string;
}

export interface ApprovalResult {
  approved: boolean;
  feedback?: string | undefined;
}

export interface ApprovalRequestedEvent {
  nodeId: string;
  nodeName: string;
  message: string;
  enableFeedback: boolean;
  resolve: (result: ApprovalResult) => void;
}

// Lifecycle events go through the EventPublisher. The emitter carries only the interactive
// approval handshake and the worktree_dirty notice.
export interface EngineEventMap {
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
