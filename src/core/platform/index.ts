export type { ClaudeOptions } from './claude/options.ts';
export { claudeOptionsSchema } from './claude/options.ts';
export { PlatformAgentNotFoundError, PlatformCancellationError, PlatformError } from './errors.ts';
export type {
  BasePlatformOptions,
  PlatformAdapter,
  PlatformStream,
  StreamEventMap,
} from './types.ts';
// ClaudeCodeAdapter will be added in Phase 3
