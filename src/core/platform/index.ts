export { ClaudeCodeAdapter } from './claude/adapter.ts';
export type { ClaudeOptions } from './claude/options.ts';
export { claudeOptionsSchema } from './claude/options.ts';
export { PlatformAgentNotFoundError, PlatformCancellationError, PlatformError } from './errors.ts';
export type { Platform } from './platform.ts';
export { DEFAULT_PLATFORM, platformSchema } from './platform.ts';
export type {
  BasePlatformOptions,
  PlatformAdapter,
  PlatformStream,
  StreamEventMap,
} from './types.ts';
