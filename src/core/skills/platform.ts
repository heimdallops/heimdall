import { z } from 'zod';

/**
 * The coding agents Heimdall can install a skill into.
 *
 * Deliberately separate from `core/platform`'s `platformSchema`, which gates a workflow's
 * `platform:` field — the agent that *executes* agentic nodes, where only Claude works
 * today. Installing a skill and running a prompt are different capabilities: widening the
 * engine's enum to cover OpenCode and Codex would let a workflow declare `platform: codex`,
 * pass validation, and fail at runtime. Two concerns, two enums.
 */
export const skillPlatformSchema = z.enum(['claude', 'opencode', 'codex']);
export type SkillPlatform = z.infer<typeof skillPlatformSchema>;
