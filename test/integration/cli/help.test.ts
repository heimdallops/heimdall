import { resolve } from 'node:path';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

describe('cli help', () => {
  it('prints top-level help text', async () => {
    const cliPath = resolve(process.cwd(), 'dist/index.js');
    const result = await execa('node', [cliPath, '--help'], {
      reject: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: heimdall');
  });
});
