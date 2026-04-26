import picocolors from 'picocolors';

export const theme = {
  info: picocolors.cyan,
  success: picocolors.green,
  warning: picocolors.yellow,
  error: picocolors.red,
  muted: picocolors.gray,
} as const;
