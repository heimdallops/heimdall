import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../../src/config/load-config.ts';

const tempDirs: string[] = [];

const makeTempCwd = async (): Promise<string> => {
  const cwd = await mkdtemp(join(tmpdir(), 'heimdall-config-'));
  tempDirs.push(cwd);

  return cwd;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadConfig', () => {
  it('returns defaults when no flags are provided', async () => {
    const cwd = await makeTempCwd();

    await expect(loadConfig({}, cwd)).resolves.toEqual({
      json: false,
      verbose: false,
      debug: false,
      quiet: false,
    });
  });

  it('resolves supported global flags into canonical config', async () => {
    const cwd = await makeTempCwd();

    await expect(loadConfig({ json: true, verbose: true, debug: true }, cwd)).resolves.toEqual({
      json: true,
      verbose: true,
      debug: true,
      quiet: false,
    });
  });

  it('loads explicit config files but rejects unsupported config keys', async () => {
    const cwd = await makeTempCwd();
    const configPath = join(cwd, 'heimdall.config.json');

    await writeFile(configPath, JSON.stringify({ json: true }), 'utf8');

    await expect(loadConfig({ config: configPath }, cwd)).rejects.toThrow();
  });
});
