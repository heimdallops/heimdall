import { z } from 'zod';

// Separate from the engine's platformSchema, which gates which agent can *run* a workflow:
// adding these there would let `platform: codex` validate and then fail at runtime.
export const skillPlatformSchema = z.enum(['claude', 'opencode', 'codex']);
export type SkillPlatform = z.infer<typeof skillPlatformSchema>;
