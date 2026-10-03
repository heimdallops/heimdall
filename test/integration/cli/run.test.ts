import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A minimal single-node workflow that always succeeds.
 * Uses a bash node with `true` so the engine has nothing real to execute.
 */
const VALID_SINGLE_NODE_YAML = `
name: integration-test-workflow
nodes:
  - id: step1
    bash: "true"
`.trimStart();

/**
 * A workflow that declares a required input with no default.
 */
const WORKFLOW_WITH_REQUIRED_INPUT_YAML = `
name: needs-input
inputs:
  token:
    type: string
nodes:
  - id: step1
    bash: "true"
`.trimStart();

/**
 * A workflow that declares an integer input with no default.
 */
const WORKFLOW_WITH_INTEGER_INPUT_YAML = `
name: needs-count
inputs:
  count:
    type: integer
nodes:
  - id: step1
    bash: "true"
`.trimStart();

/**
 * A workflow whose single node exits with code 1 (failure).
 */
const FAILING_WORKFLOW_YAML = `
name: failing-workflow
nodes:
  - id: fail_step
    bash: "exit 1"
`.trimStart();

/**
 * Text that is not valid YAML.
 */
const INVALID_YAML = `name: [unclosed bracket`;

/**
 * Valid YAML that is not a valid workflow schema (missing required nodes field).
 */
const EMPTY_FILE_YAML = ``;

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe('heimdall run — integration', () => {
  const cliPath = resolve(process.cwd(), 'dist/index.js');

  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'heimdall-run-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const writeWorkflow = async (filename: string, content: string): Promise<string> => {
    const filePath = join(tmpDir, filename);
    await writeFile(filePath, content, 'utf8');

    return filePath;
  };

  // -------------------------------------------------------------------------
  // SC-001: Valid single-node workflow
  // -------------------------------------------------------------------------

  describe('SC-001: valid single-node workflow', () => {
    it('exits 0 on a valid workflow with a single bash node', async () => {
      const filePath = await writeWorkflow('workflow.yaml', VALID_SINGLE_NODE_YAML);

      const result = await execa('node', [cliPath, 'run', filePath], { reject: false });

      expect(result.exitCode).toBe(0);
    });

    it('reports node started in stderr output', async () => {
      const filePath = await writeWorkflow('workflow.yaml', VALID_SINGLE_NODE_YAML);

      const result = await execa('node', [cliPath, 'run', filePath], { reject: false });

      expect(result.stderr).toMatch(/step1/i);
    });

    it('reports node completed in stderr output', async () => {
      const filePath = await writeWorkflow('workflow.yaml', VALID_SINGLE_NODE_YAML);

      const result = await execa('node', [cliPath, 'run', filePath], { reject: false });

      // node_completed fires → printer.success("Node completed: step1")
      expect(result.stderr).toMatch(/complet/i);
    });
  });

  // -------------------------------------------------------------------------
  // SC-002: Missing required input
  // -------------------------------------------------------------------------

  describe('SC-002: missing required input', () => {
    it('exits 2 when a required input is not provided', async () => {
      const filePath = await writeWorkflow('workflow.yaml', WORKFLOW_WITH_REQUIRED_INPUT_YAML);

      const result = await execa('node', [cliPath, 'run', filePath], { reject: false });

      expect(result.exitCode).toBe(2);
    });

    it('names the missing input in the error output', async () => {
      const filePath = await writeWorkflow('workflow.yaml', WORKFLOW_WITH_REQUIRED_INPUT_YAML);

      const result = await execa('node', [cliPath, 'run', filePath], { reject: false });

      expect(result.stderr).toContain('token');
    });

    it('reports the error before any node executes (no node-started output)', async () => {
      const filePath = await writeWorkflow('workflow.yaml', WORKFLOW_WITH_REQUIRED_INPUT_YAML);

      const result = await execa('node', [cliPath, 'run', filePath], { reject: false });

      // The missing-input check runs before workflow.run() so no node_started fires
      expect(result.stderr).not.toMatch(/node started/i);
    });
  });

  // -------------------------------------------------------------------------
  // SC-003: Invalid YAML file
  // -------------------------------------------------------------------------

  describe('SC-003: invalid YAML file', () => {
    it('exits 2 on a syntactically invalid YAML file', async () => {
      const filePath = await writeWorkflow('bad.yaml', INVALID_YAML);

      const result = await execa('node', [cliPath, 'run', filePath], { reject: false });

      expect(result.exitCode).toBe(2);
    });

    it('reports an error message without a stack trace on stderr', async () => {
      const filePath = await writeWorkflow('bad.yaml', INVALID_YAML);

      const result = await execa('node', [cliPath, 'run', filePath], { reject: false });

      expect(result.stderr.length).toBeGreaterThan(0);
      // No raw stack trace should leak to the user
      expect(result.stderr).not.toMatch(/^\s+at /m);
    });

    it('does not produce output on stdout for a bad YAML file', async () => {
      const filePath = await writeWorkflow('bad.yaml', INVALID_YAML);

      const result = await execa('node', [cliPath, 'run', filePath], { reject: false });

      expect(result.stdout).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // SC-004: --json flag on successful workflow
  // -------------------------------------------------------------------------

  describe('SC-004: --json flag on valid workflow', () => {
    it('exits 0 with --json on a valid workflow', async () => {
      const filePath = await writeWorkflow('workflow.yaml', VALID_SINGLE_NODE_YAML);

      const result = await execa('node', [cliPath, 'run', '--json', filePath], { reject: false });

      expect(result.exitCode).toBe(0);
    });

    it('writes exactly one JSON line to stdout with success:true', async () => {
      const filePath = await writeWorkflow('workflow.yaml', VALID_SINGLE_NODE_YAML);

      const result = await execa('node', [cliPath, 'run', '--json', filePath], { reject: false });

      const lines = result.stdout.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(parsed['success']).toBe(true);
    });

    it('produces no other lines on stdout in --json mode', async () => {
      const filePath = await writeWorkflow('workflow.yaml', VALID_SINGLE_NODE_YAML);

      const result = await execa('node', [cliPath, 'run', '--json', filePath], { reject: false });

      // All human-readable progress goes to stderr, not stdout
      const nonJsonLines = result.stdout
        .split('\n')
        .filter(Boolean)
        .filter((line) => {
          try {
            JSON.parse(line);

            return false;
          } catch {
            return true;
          }
        });
      expect(nonJsonLines).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // SC-005: File not found
  // -------------------------------------------------------------------------

  describe('SC-005: file not found', () => {
    it('exits 2 when the workflow file does not exist', async () => {
      const result = await execa('node', [cliPath, 'run', '/nonexistent/path/workflow.yaml'], {
        reject: false,
      });

      expect(result.exitCode).toBe(2);
    });

    it('reports an error on stderr when the file is not found', async () => {
      const result = await execa('node', [cliPath, 'run', '/nonexistent/path/workflow.yaml'], {
        reject: false,
      });

      expect(result.stderr.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // SC-006: Unknown --input key
  // -------------------------------------------------------------------------

  describe('SC-006: unknown --input key', () => {
    it('exits 2 when an unknown --input key is provided', async () => {
      const filePath = await writeWorkflow('workflow.yaml', VALID_SINGLE_NODE_YAML);

      const result = await execa('node', [cliPath, 'run', '--input', 'ghost=value', filePath], {
        reject: false,
      });

      expect(result.exitCode).toBe(2);
    });

    it('names the unknown key in the error output', async () => {
      const filePath = await writeWorkflow('workflow.yaml', VALID_SINGLE_NODE_YAML);

      const result = await execa('node', [cliPath, 'run', '--input', 'ghost=value', filePath], {
        reject: false,
      });

      expect(result.stderr).toContain('ghost');
    });
  });

  // -------------------------------------------------------------------------
  // SC-007: --json flag on a failing workflow
  // -------------------------------------------------------------------------

  describe('SC-007: --json flag on a failing workflow', () => {
    it('exits 6 when the workflow fails in --json mode', async () => {
      const filePath = await writeWorkflow('workflow.yaml', FAILING_WORKFLOW_YAML);

      const result = await execa('node', [cliPath, 'run', '--json', filePath], { reject: false });

      expect(result.exitCode).toBe(6);
    });

    it('writes a JSON line containing success:false to stdout when the workflow fails', async () => {
      const filePath = await writeWorkflow('workflow.yaml', FAILING_WORKFLOW_YAML);

      const result = await execa('node', [cliPath, 'run', '--json', filePath], { reject: false });

      const lines = result.stdout.trim().split('\n').filter(Boolean);
      const resultLine = lines.find((l) => {
        try {
          const parsed = JSON.parse(l) as Record<string, unknown>;

          return 'success' in parsed;
        } catch {
          return false;
        }
      });
      expect(resultLine).toBeDefined();
      const parsed = JSON.parse(resultLine!) as Record<string, unknown>;
      expect(parsed['success']).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Additional edge cases
  // -------------------------------------------------------------------------

  describe('empty / schema-invalid YAML', () => {
    it('exits 2 for an empty file', async () => {
      const filePath = await writeWorkflow('empty.yaml', EMPTY_FILE_YAML);

      const result = await execa('node', [cliPath, 'run', filePath], { reject: false });

      expect(result.exitCode).toBe(2);
    });
  });

  describe('--input with = in the value', () => {
    it('accepts an --input value that contains "=" characters', async () => {
      const yaml = `
name: url-workflow
inputs:
  url:
    type: string
nodes:
  - id: step1
    bash: "true"
`.trimStart();
      const filePath = await writeWorkflow('workflow.yaml', yaml);

      const result = await execa(
        'node',
        [cliPath, 'run', '--input', 'url=https://example.com?a=1&b=2', filePath],
        { reject: false }
      );

      // The value after the first = must be preserved intact; the command should succeed
      expect(result.exitCode).toBe(0);
    });
  });

  describe('typed --input coercion', () => {
    it('accepts a valid integer value for an integer input', async () => {
      const filePath = await writeWorkflow('workflow.yaml', WORKFLOW_WITH_INTEGER_INPUT_YAML);

      const result = await execa('node', [cliPath, 'run', '--input', 'count=3', filePath], {
        reject: false,
      });

      expect(result.exitCode).toBe(0);
    });

    it('exits 2 when an integer input receives a non-integer value', async () => {
      const filePath = await writeWorkflow('workflow.yaml', WORKFLOW_WITH_INTEGER_INPUT_YAML);

      const result = await execa('node', [cliPath, 'run', '--input', 'count=abc', filePath], {
        reject: false,
      });

      expect(result.exitCode).toBe(2);
    });

    it('names the offending input in the error output', async () => {
      const filePath = await writeWorkflow('workflow.yaml', WORKFLOW_WITH_INTEGER_INPUT_YAML);

      const result = await execa('node', [cliPath, 'run', '--input', 'count=abc', filePath], {
        reject: false,
      });

      expect(result.stderr).toContain('count');
    });
  });

  describe('missing file argument', () => {
    it('exits with a non-zero code when no file argument is provided', async () => {
      const result = await execa('node', [cliPath, 'run'], { reject: false });

      expect(result.exitCode).not.toBe(0);
    });
  });
});
