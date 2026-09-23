import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AgenticBaseNodeSchema,
  AgentNodeSchema,
  ApprovalNodeSchema,
  BashNodeSchema,
  BreakNodeSchema,
  ExitNodeSchema,
  LoopNodeSchema,
  PromptFileNodeSchema,
  PromptNodeSchema,
  WorkflowDefinitionSchema,
  WorkspaceConfigSchema,
} from '../../../../src/core/engine/schema.ts';
import { claudeOptionsSchema } from '../../../../src/core/platform/claude/options.ts';

/**
 * `schemas/*.yaml` is the source of truth for workflow structure, and most of `schema.ts` is
 * generated from it. Two things can still pull them apart, and these tests cover both:
 *
 * 1. A schema that is *not* generated — `claudeOptionsSchema` lives in the platform layer and
 *    is hand-written — can drift from its document freely. This is the drift that actually
 *    happened: `claude_options.yaml` documented four options the adapter silently discarded.
 * 2. A generated file committed stale still compiles, so the engine would validate against
 *    yesterday's document.
 */

const schemasDir = join(process.cwd(), 'schemas');
const docs = new Map<string, Record<string, unknown>>();

const loadDoc = (relative: string): Record<string, unknown> => {
  const key = posix.normalize(relative);

  if (!docs.has(key)) {
    docs.set(key, load(readFileSync(join(schemasDir, key), 'utf8')) as Record<string, unknown>);
  }

  return docs.get(key)!;
};

interface Flattened {
  readonly properties: Set<string>;
  readonly required: Set<string>;
}

/** Resolves `allOf` composition and cross-file `$ref` the way the generator does. */
const flatten = (relative: string): Flattened => {
  const properties = new Set<string>();
  const required = new Set<string>();

  const visit = (node: Record<string, unknown>, base: string): void => {
    const ref = node['$ref'];

    if (typeof ref === 'string') {
      const target = posix.join(base, ref);
      visit(loadDoc(target), posix.dirname(target));

      return;
    }

    for (const branch of (node['allOf'] ?? []) as Record<string, unknown>[]) {
      visit(branch, base);
    }

    for (const name of Object.keys(node['properties'] ?? {})) {
      properties.add(name);
    }

    for (const name of (node['required'] ?? []) as string[]) {
      required.add(name);
    }
  };

  visit(loadDoc(relative), posix.dirname(relative));

  return { properties, required };
};

const zodShape = (target: z.ZodType): Flattened => {
  const json = z.toJSONSchema(target, { unrepresentable: 'any', io: 'input' }) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };

  return {
    properties: new Set(Object.keys(json.properties ?? {})),
    required: new Set(json.required ?? []),
  };
};

const PAIRS: [string, z.ZodType][] = [
  ['workflow.yaml', WorkflowDefinitionSchema],
  ['bash_node.yaml', BashNodeSchema],
  ['agentic_node.yaml', AgenticBaseNodeSchema],
  ['agent_node.yaml', AgentNodeSchema],
  ['prompt_node.yaml', PromptNodeSchema],
  ['prompt_file_node.yaml', PromptFileNodeSchema],
  ['approval_node.yaml', ApprovalNodeSchema],
  ['exit_node.yaml', ExitNodeSchema],
  ['break_node.yaml', BreakNodeSchema],
  ['loop_node.yaml', LoopNodeSchema],
  ['workspace.yaml', WorkspaceConfigSchema],
  // Hand-written and outside the generator's reach, so this row is the one that earns its keep.
  ['claude_options.yaml', claudeOptionsSchema],
];

describe('schema drift — documents against validators', () => {
  it.each(PAIRS)('%s declares the same fields the code accepts', (file, target) => {
    const doc = flatten(file);
    const code = zodShape(target);

    expect([...doc.properties].sort(), `documented but not accepted (${file})`).toEqual(
      [...code.properties].sort()
    );
  });

  it.each(PAIRS)('%s agrees on which fields are required', (file, target) => {
    expect([...flatten(file).required].sort()).toEqual([...zodShape(target).required].sort());
  });
});

describe('generated shapes are up to date', () => {
  it('matches a fresh run of the generator', async () => {
    // A stale generated file still compiles, so nothing else would notice that the engine is
    // validating against an older version of the documents than the ones we publish.
    const committed = await readFile('src/core/engine/generated/schema-shapes.ts', 'utf8');
    const scratch = await mkdtemp(join(tmpdir(), 'heimdall-schema-gen-'));

    execFileSync('node', ['scripts/generate-schema.js'], {
      env: { ...process.env, HEIMDALL_SCHEMA_OUT: join(scratch, 'schema-shapes.ts') },
      stdio: 'pipe',
    });

    const regenerated = await readFile(join(scratch, 'schema-shapes.ts'), 'utf8');

    expect(regenerated).toBe(committed);
  });
});
