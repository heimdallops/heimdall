#!/usr/bin/env node
// Generates src/core/engine/generated/schema-shapes.ts from the JSON Schema documents under
// schemas/.
//
// Those documents are the source of truth for a workflow's *structure* — field names, types,
// optionality, enums, bounds — and for the prose describing it. They cannot express behaviour:
// normalising transforms, cross-field refinements, and custom error messages have no JSON Schema
// equivalent. Those stay hand-written in schema.ts, which composes them over what is emitted here.
// Hence "shapes": these are the structural halves, not the validators the engine runs.
//
// The generator REFUSES rather than degrades. Emitting z.any() for a construct it does not
// understand would reintroduce exactly the silent-drift problem this exists to end, so an
// unrecognised construct throws and names its location.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Overridable so tests can point the generator at a deliberately broken copy.
const schemasDir = process.env['HEIMDALL_SCHEMA_DIR'] ?? join(repoRoot, 'schemas');
// Overridable so the staleness test can generate into a scratch directory and compare, rather
// than writing over the committed file to find out whether it was current.
const outFile =
  process.env['HEIMDALL_SCHEMA_OUT'] ??
  join(repoRoot, 'src', 'core', 'engine', 'generated', 'schema-shapes.ts');

/**
 * Files that have a Zod counterpart, and the export name to emit for each.
 *
 * `schemas/results/*.yaml` are deliberately absent: they document runtime result shapes built in
 * nodes/*.ts, for which no Zod schema exists. `node_union.yaml` is absent too — it models node
 * dispatch as a oneOf, but the engine uses an open NodeSchema plus first-match registry lookup
 * (nodes/registry.ts), so generating from it would describe an architecture the engine does not
 * have.
 */
const MAPPED = [
  ['node.yaml', 'baseNodeShape'],
  ['workspace.yaml', 'workspaceConfigShape'],
  ['bash_node.yaml', 'bashNodeShape'],
  ['agentic_node.yaml', 'agenticBaseNodeShape'],
  ['agent_node.yaml', 'agentNodeShape'],
  ['prompt_node.yaml', 'promptNodeShape'],
  ['prompt_file_node.yaml', 'promptFileNodeShape'],
  ['approval_node.yaml', 'approvalNodeShape'],
  ['exit_node.yaml', 'exitNodeShape'],
  ['break_node.yaml', 'breakNodeShape'],
  ['loop_node.yaml', 'loopNodeShape'],
  ['workflow.yaml', 'workflowDefinitionShape'],
];

/**
 * `$ref` targets inside a property where the engine deliberately does not match the document.
 *
 * Each of these is a real divergence, not a shortcut, and naming them in one table is the point:
 * it keeps the difference reviewable instead of buried in whichever file happens to reference it.
 */
const REF_OVERRIDES = new Map([
  [
    'platform.yaml',
    {
      expression: 'platformSchema',
      reason: "the enum lives in core/platform and gates the engine's adapter factory",
    },
  ],
  [
    'platform_options_union.yaml',
    {
      expression: 'z.record(z.string(), z.unknown())',
      reason: 'the engine stays platform-agnostic and lets each adapter validate its own options',
    },
  ],
  [
    'node_union.yaml',
    {
      expression: 'z.object({ id: z.string() }).loose()',
      reason:
        'the document models a closed oneOf, but the engine uses an open node schema plus ' +
        'first-match registry dispatch (nodes/registry.ts), so a closed union would describe ' +
        'an architecture the engine does not have',
    },
  ],
]);

const docs = new Map();

const loadDoc = async (relative) => {
  const key = posix.normalize(relative);

  if (!docs.has(key)) {
    docs.set(key, yaml.load(await readFile(join(schemasDir, key), 'utf8')));
  }

  return docs.get(key);
};

const fail = (pointer, message) => {
  throw new Error(`generate-schema: ${pointer}: ${message}`);
};

/**
 * Flattens `allOf` composition and cross-file `$ref` into a single object schema.
 *
 * The node schemas are written as `allOf: [$ref: node.yaml, {...}]`, so without this every
 * inherited field would look absent. Later branches win, matching how allOf narrows.
 */
const flatten = async (doc, dir, pointer) => {
  const properties = new Map();
  const required = new Set();

  const visit = async (node, base, at) => {
    if (node === null || typeof node !== 'object') {
      fail(at, 'expected an object schema');
    }

    if (typeof node.$ref === 'string') {
      if (!node.$ref.endsWith('.yaml')) {
        fail(at, `unsupported $ref "${node.$ref}" — only sibling .yaml files are supported`);
      }

      const relative = posix.join(base, node.$ref);
      await visit(await loadDoc(relative), posix.dirname(relative), relative);

      return;
    }

    for (const [index, branch] of (node.allOf ?? []).entries()) {
      await visit(branch, base, `${at}/allOf/${index}`);
    }

    for (const [name, property] of Object.entries(node.properties ?? {})) {
      properties.set(name, { property, pointer: `${at}/properties/${name}` });
    }

    for (const name of node.required ?? []) {
      required.add(name);
    }
  };

  await visit(doc, dir, pointer);

  return { properties, required };
};

const quote = (value) => JSON.stringify(value);

const describe = (expression, description) =>
  description === undefined ? expression : `${expression}.describe(${quote(description)})`;

/** Maps one JSON Schema property to a Zod expression, or throws naming what it could not map. */
const toZod = (schema, pointer) => {
  if (schema === null || typeof schema !== 'object') {
    fail(pointer, 'expected an object schema');
  }

  const { description } = schema;

  if (Array.isArray(schema.oneOf)) {
    const members = schema.oneOf.map((member, index) => toZod(member, `${pointer}/oneOf/${index}`));

    return describe(`z.union([${members.join(', ')}])`, description);
  }

  if (schema.$ref !== undefined) {
    const target = posix.normalize(schema.$ref);
    const override = REF_OVERRIDES.get(target);

    if (override !== undefined) {
      return describe(override.expression, description);
    }

    const mapped = MAPPED.find(([file]) => file === target);

    if (mapped !== undefined) {
      return describe(mapped[1], description);
    }

    fail(pointer, `$ref "${schema.$ref}" has no mapped shape and no override`);
  }

  if (schema.type === undefined) {
    // A schema carrying nothing but prose is JSON Schema's idiom for "any value", and some
    // fields genuinely mean it — break_node's `break` is documented as "the value is ignored;
    // only the presence of this field matters". Accept that exact shape and nothing looser: a
    // property with other keys but no type is a mistake, not an intention.
    const meaningful = Object.keys(schema).filter((key) => key !== 'description');

    if (meaningful.length === 0) {
      return describe('z.unknown()', description);
    }

    fail(pointer, `no "type" alongside ${meaningful.join(', ')} — refusing to guess`);
  }

  switch (schema.type) {
    case 'string': {
      if (Array.isArray(schema.enum)) {
        return describe(`z.enum([${schema.enum.map(quote).join(', ')}])`, description);
      }

      let expression = 'z.string()';
      if (typeof schema.minLength === 'number') {
        expression += `.min(${schema.minLength})`;
      }

      if (typeof schema.pattern === 'string') {
        expression += `.regex(new RegExp(${quote(schema.pattern)}))`;
      }

      return describe(expression, description);
    }

    case 'boolean':
      return describe('z.boolean()', description);

    case 'integer':
    case 'number': {
      let expression = 'z.number()';
      if (schema.type === 'integer') {
        expression += '.int()';
      }

      if (typeof schema.minimum === 'number') {
        expression += `.min(${schema.minimum})`;
      }

      if (typeof schema.maximum === 'number') {
        expression += `.max(${schema.maximum})`;
      }

      return describe(expression, description);
    }

    case 'array': {
      if (schema.items === undefined) {
        fail(pointer, 'array without "items"');
      }

      let expression = `z.array(${toZod(schema.items, `${pointer}/items`)})`;
      if (typeof schema.minItems === 'number') {
        expression += `.min(${schema.minItems})`;
      }

      return describe(expression, description);
    }

    case 'object': {
      // A map: `additionalProperties` describes the value type of arbitrary keys.
      if (schema.properties === undefined) {
        const value =
          schema.additionalProperties === undefined || schema.additionalProperties === true
            ? 'z.unknown()'
            : toZod(schema.additionalProperties, `${pointer}/additionalProperties`);

        return describe(`z.record(z.string(), ${value})`, description);
      }

      const required = new Set(schema.required ?? []);
      const entries = Object.entries(schema.properties).map(([name, property]) => {
        const member = toZod(property, `${pointer}/properties/${name}`);

        return `    ${JSON.stringify(name)}: ${member}${required.has(name) ? '' : '.optional()'},`;
      });

      return describe(`z.object({\n${entries.join('\n')}\n  })`, description);
    }

    default:
      fail(pointer, `unsupported type ${quote(String(schema.type))}`);
  }

  return undefined;
};

const emitShape = async (file, exportName) => {
  const doc = await loadDoc(file);
  const { properties, required } = await flatten(doc, '.', file);

  if (properties.size === 0) {
    fail(file, 'no properties after flattening — nothing to generate');
  }

  const entries = [...properties.entries()].map(([name, { property, pointer }]) => {
    const member = toZod(property, pointer);

    return `  ${JSON.stringify(name)}: ${member}${required.has(name) ? '' : '.optional()'},`;
  });

  const description =
    typeof doc.description === 'string'
      ? `\n/** ${doc.description.replace(/\s+/g, ' ').trim()} */`
      : '';

  return `${description}\nexport const ${exportName} = z.object({\n${entries.join('\n')}\n});\n`;
};

const shapes = [];
for (const [file, exportName] of MAPPED) {
  shapes.push(await emitShape(file, exportName));
}

const source = `// GENERATED BY scripts/generate-schema.js — DO NOT EDIT.
// Source of truth: schemas/*.yaml. Run \`npm run generate:schema\` to regenerate.
//
// These are structural shapes only. Behaviour that JSON Schema cannot express — normalising
// transforms, cross-field refinements, custom error messages — is composed over them in
// ../schema.ts, which is what the engine actually validates against.

import { z } from 'zod';

import { platformSchema } from '../../platform/platform.ts';
${shapes.join('')}`;

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, source, 'utf8');

process.stderr.write(`generate-schema: wrote ${MAPPED.length} shape(s) to ${outFile}\n`);
