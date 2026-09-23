import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The generator's contract has two halves. It must map JSON Schema onto Zod faithfully, and —
 * more importantly — it must **refuse** anything it cannot map. Emitting `z.any()` for an
 * unfamiliar construct would put the silent drift straight back, this time inside the validator
 * rather than beside it, so the refusals are tested as carefully as the mappings.
 */

let generated = '';

beforeAll(async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'heimdall-generate-schema-'));
  const out = join(scratch, 'schema-shapes.ts');

  execFileSync('node', ['scripts/generate-schema.js'], {
    env: { ...process.env, HEIMDALL_SCHEMA_OUT: out },
    stdio: 'pipe',
  });

  generated = await readFile(out, 'utf8');
});

describe('generate-schema — mapping', () => {
  it.each([
    ['a required string', 'bash_node.yaml', '"bash": z.string()'],
    ['an optional field', 'node.yaml', '"name": z.string()'],
    ['a string enum', 'bash_node.yaml', 'z.enum(["text", "json"])'],
    ['a bounded integer', 'loop_node.yaml', 'z.number().int().min(1)'],
    ['a bounded number', 'node.yaml', 'z.number().min(0)'],
    ['an array with a minimum', 'workflow.yaml', '.min(1)'],
    ['a map of strings', 'bash_node.yaml', 'z.record(z.string(), z.string())'],
    ['a boolean', 'workspace.yaml', 'z.boolean()'],
    ['a regex pattern', 'node.yaml', 'regex(new RegExp("^[A-Za-z_][A-Za-z0-9_]*$"))'],
    ['an explicit any', 'break_node.yaml', '"break": z.unknown()'],
  ])('maps %s', (_label, _file, expected) => {
    expect(generated).toContain(expected);
  });

  it('carries every description through to .describe()', () => {
    expect(generated).toContain('.describe("Max number of retry attempts.")');
  });

  it('marks non-required fields optional and leaves required ones alone', () => {
    expect(generated).toMatch(/"name": z\.string\(\)[^\n]*\.optional\(\),/);
    expect(generated).toMatch(/"id": z\.string\(\)(?![^\n]*\.optional\(\))/);
  });

  it('resolves allOf inheritance so a node type carries the base fields', () => {
    // bash_node.yaml is `allOf: [$ref: node.yaml, {...}]`; without resolution `id` would vanish.
    const bashShape = /export const bashNodeShape = z\.object\(\{([\s\S]*?)\n\}\);/.exec(generated);

    expect(bashShape?.[1]).toContain('"id"');
    expect(bashShape?.[1]).toContain('"bash"');
  });

  it('routes an overridden $ref to the engine’s own type', () => {
    // platform.yaml must reach the enum the adapter factory switches on, not a copy of it.
    expect(generated).toContain('"platform": platformSchema');
    expect(generated).toContain("import { platformSchema } from '../../platform/platform.ts';");
  });

  it('is deterministic', async () => {
    const run = (): string => {
      const out = join(tmpdir(), `heimdall-det-${String(Math.random()).slice(2)}.ts`);
      execFileSync('node', ['scripts/generate-schema.js'], {
        env: { ...process.env, HEIMDALL_SCHEMA_OUT: out },
        stdio: 'pipe',
      });

      return out;
    };

    await expect(readFile(run(), 'utf8')).resolves.toBe(generated);
  });
});

describe('generate-schema — refusals', () => {
  const generateWith = async (file: string, body: string): Promise<string> => {
    const scratch = await mkdtemp(join(tmpdir(), 'heimdall-generate-bad-'));

    // Copy the real schemas, then break one, so the failure is about the construct and not
    // about a hand-built fixture missing something the generator needs.
    execFileSync('cp', ['-R', 'schemas', join(scratch, 'schemas')]);
    execFileSync('bash', ['-c', `cat > ${JSON.stringify(join(scratch, 'schemas', file))}`], {
      input: body,
    });

    try {
      execFileSync('node', ['scripts/generate-schema.js'], {
        env: {
          ...process.env,
          HEIMDALL_SCHEMA_DIR: join(scratch, 'schemas'),
          HEIMDALL_SCHEMA_OUT: join(scratch, 'out.ts'),
        },
        stdio: 'pipe',
      });
    } catch (error) {
      return String((error as { stderr?: Buffer }).stderr ?? '');
    }

    throw new Error('expected the generator to refuse, but it succeeded');
  };

  it('refuses a property with no type', async () => {
    const message = await generateWith(
      'workspace.yaml',
      'type: object\nproperties:\n  worktree:\n    minimum: 0\n'
    );

    expect(message).toContain('refusing to guess');
    expect(message).toContain('workspace.yaml');
  });

  it('refuses an unknown type', async () => {
    const message = await generateWith(
      'workspace.yaml',
      'type: object\nproperties:\n  worktree:\n    type: bigint\n'
    );

    expect(message).toContain('unsupported type');
  });

  it('refuses an array without items', async () => {
    const message = await generateWith(
      'workspace.yaml',
      'type: object\nproperties:\n  worktree:\n    type: array\n'
    );

    expect(message).toContain('array without "items"');
  });

  it('refuses a $ref it has no shape or override for', async () => {
    const message = await generateWith(
      'workspace.yaml',
      'type: object\nproperties:\n  worktree:\n    $ref: results/builtins.yaml\n'
    );

    expect(message).toContain('has no mapped shape and no override');
  });

  it('names the file and the path when it refuses', async () => {
    const message = await generateWith(
      'workspace.yaml',
      'type: object\nproperties:\n  worktree:\n    type: bigint\n'
    );

    expect(message).toContain('workspace.yaml/properties/worktree');
  });
});
