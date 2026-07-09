import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Heimdall's config home: `$XDG_CONFIG_HOME` when set (non-empty), otherwise `~/.config`. An unset
 * or empty value falls back rather than resolving relative to cwd.
 */
export const configHome = (): string => {
  const xdg = process.env['XDG_CONFIG_HOME']?.trim();
  if (!xdg) {
    return join(homedir(), '.config');
  }

  return xdg;
};
