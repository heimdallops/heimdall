import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../../src/config/load-config.ts';

const tempDirs: string[] = [];

const makeTempCwd = async (): Promise<string> => {
  const cwd = await mkdtemp(join(tmpdir(), 'heimdall-config-'));
  tempDirs.push(cwd);

  return cwd;
};

afterEach(async () => {
  vi.unstubAllEnvs();
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

  describe('claudeCodeExecutable', () => {
    it('is undefined by default', async () => {
      const cwd = await makeTempCwd();

      const config = await loadConfig({}, cwd);

      expect(config.claudeCodeExecutable).toBeUndefined();
    });

    it('loads from the config file', async () => {
      const cwd = await makeTempCwd();
      const configPath = join(cwd, 'heimdall.config.json');
      await writeFile(configPath, JSON.stringify({ claudeCodeExecutable: '/from/file' }), 'utf8');

      const config = await loadConfig({ config: configPath }, cwd);

      expect(config.claudeCodeExecutable).toBe('/from/file');
    });

    it('lets HEIMDALL_CLAUDE_CODE_EXECUTABLE override the config file', async () => {
      const cwd = await makeTempCwd();
      const configPath = join(cwd, 'heimdall.config.json');
      await writeFile(configPath, JSON.stringify({ claudeCodeExecutable: '/from/file' }), 'utf8');
      vi.stubEnv('HEIMDALL_CLAUDE_CODE_EXECUTABLE', '/from/env');

      const config = await loadConfig({ config: configPath }, cwd);

      expect(config.claudeCodeExecutable).toBe('/from/env');
    });

    it('rejects an empty HEIMDALL_CLAUDE_CODE_EXECUTABLE', async () => {
      const cwd = await makeTempCwd();
      vi.stubEnv('HEIMDALL_CLAUDE_CODE_EXECUTABLE', '');

      await expect(loadConfig({}, cwd)).rejects.toThrow();
    });
  });
});
