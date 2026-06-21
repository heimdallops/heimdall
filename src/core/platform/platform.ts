import { z } from 'zod';

export const platformSchema = z.enum(['claude']);
export type Platform = z.infer<typeof platformSchema>;
export const DEFAULT_PLATFORM: Platform = 'claude';
