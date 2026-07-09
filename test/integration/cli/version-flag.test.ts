import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

describe('cli version flag', () => {
  it('prints the package version and exits successfully', async () => {
    const cliPath = resolve(process.cwd(), 'dist/index.js');
    const packageJson = JSON.parse(
      await readFile(resolve(process.cwd(), 'package.json'), 'utf8')
    ) as { version: string };

    const result = await execa('node', [cliPath, '--version'], {
      reject: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(packageJson.version);
    expect(result.stderr).toBe('');
  });
});
