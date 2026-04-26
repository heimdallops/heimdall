import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../../src/config/load-config.ts';

describe('loadConfig', () => {
  it('returns defaults when no flags are provided', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'heimdall-config-'));

    await expect(loadConfig({}, cwd)).resolves.toEqual({
      json: false,
      verbose: false,
      debug: false,
    });
  });

  it('resolves supported global flags into canonical config', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'heimdall-config-'));

    await expect(loadConfig({ json: true, verbose: true, debug: true }, cwd)).resolves.toEqual({
      json: true,
      verbose: true,
      debug: true,
    });
  });

  it('loads explicit config files but rejects unsupported config keys', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'heimdall-config-'));
    const configPath = join(cwd, 'heimdall.config.json');

    await writeFile(configPath, JSON.stringify({ json: true }), 'utf8');

    await expect(loadConfig({ config: configPath }, cwd)).rejects.toThrow();
  });
});
