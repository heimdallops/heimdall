import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { RESERVED_IDS } from '../../../../src/core/engine/nodes/base.ts';
import { listSkills } from '../../../../src/core/skills/index.ts';

// The skill ships prose and schemas that teach the expression language. Nothing in the engine
// fails when that content drifts from what the engine actually binds, so these tests pin the
// content to the engine instead. They are deliberately about vocabulary, not phrasing: a
// namespace change should break them, a reworded sentence should not.

const skill = (): NonNullable<ReturnType<typeof listSkills>[number]> => {
  const found = listSkills().find((candidate) => candidate.name === 'heimdall-workflows');

  if (found === undefined) {
    throw new Error('heimdall-workflows skill is absent from the bundle');
  }

  return found;
};

const shippedText = (): string =>
  [skill().body, ...skill().references.map((ref) => ref.contents)].join('\n');

const yamlExamples = (): string[] =>
  [...skill().body.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');

// Where a retired spelling would actually mislead: inside an example an agent copies, or inside a
// schema it treats as authoritative. The body's prose names the retired spellings on purpose — the
// writing checklist tells an agent which ones not to reach for — so prose is checked separately,
// for interpolations rather than mentions.
const usageSites = (): { label: string; text: string }[] => [
  ...yamlExamples().map((text, index) => ({ label: `example ${index + 1}`, text })),
  ...skill().references.map((ref) => ({ label: ref.path, text: ref.contents })),
];

describe('skill content — expression namespace', () => {
  // Retired by the five-roots change. Each pattern matches the old spelling in a way the current
  // spelling cannot satisfy: `needs.` only when not already reached through self./scopes./prev.
  const retired: [string, RegExp][] = [
    ['scope.loop', /\bscope\.loop\b/],
    ['scope.needs', /\bscope\.needs\b/],
    ['scope.nodes', /\bscope\.nodes\b/],
    ['scope.outer', /\bscope\.outer\b/],
    ['scope.iteration', /\bscope\.iteration\b/],
    ['sessionDir', /\bsessionDir\b/],
    ['total_iterations', /\btotal_iterations\b/],
    ['bare needs.<id>', /(?<![.\w])needs\.</],
  ];

  it.each(retired)('uses no retired %s reference in any example or schema', (_label, pattern) => {
    for (const site of usageSites()) {
      expect(site.text, site.label).not.toMatch(pattern);
    }
  });

  it('interpolates nothing off a retired root in the prose', () => {
    const interpolations = [...skill().body.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map(
      (match) => match[1] ?? ''
    );

    expect(interpolations.length).toBeGreaterThan(0);

    for (const expression of interpolations) {
      for (const [label, pattern] of retired) {
        expect(expression, label).not.toMatch(pattern);
      }
    }
  });

  it.each([
    'self.needs',
    'self.nodes',
    'self.iterations',
    'scopes.',
    'heimdall.session_dir',
    'heimdall.run_cwd',
  ])('teaches the current %s binding', (token) => {
    expect(shippedText()).toContain(token);
  });

  it('lists every reserved node id the engine rejects', () => {
    const { body } = skill();

    for (const reserved of RESERVED_IDS) {
      expect(body).toContain(`\`${reserved}\``);
    }
  });
});

describe('skill content — examples', () => {
  // A ternary in a bare-CEL value is a YAML parse error unless quoted, which makes a wrong
  // example fail before Heimdall ever sees it. Parse every block so that cannot ship.
  it('parses every YAML example in the skill body', () => {
    const blocks = [...skill().body.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1]);

    expect(blocks.length).toBeGreaterThan(0);

    for (const block of blocks) {
      expect(() => load(block ?? '')).not.toThrow();
    }
  });

  it('parses every bundled reference schema', () => {
    for (const reference of skill().references) {
      expect(() => load(reference.contents), reference.path).not.toThrow();
    }
  });
});

// Vocabulary checks cannot catch a claim that is well-spelled and wrong. These pin the
// specific result shapes and option names an audit found the content had misstated — each
// one would have produced a workflow that fails at runtime.
describe('skill content — result shapes and option names', () => {
  it('reads approval results off the top level, never under output', () => {
    // ApprovalNode returns { approved, feedback } with no wrapper (nodes/approval.ts).
    expect(shippedText()).not.toMatch(/needs\.[\w<>.]*\.output\.approved/);
    expect(shippedText()).not.toMatch(/needs\.[\w<>.]*\.output\.feedback/);
    expect(skill().body).toContain('self.needs.<id>.approved');
  });

  it('does not promise that an agentic node yields a structured object', () => {
    // AgenticNode always resolves { output: buffer } — nothing parses it (nodes/agentic.ts).
    const claimsParsing =
      /output_format[^.]{0,120}(structured object|parsed as JSON|accessible directly)/i;

    for (const site of [skill().body, ...skill().references.map((ref) => ref.contents)]) {
      expect(site).not.toMatch(claimsParsing);
    }
  });

  it('names no platform option the Claude adapter would discard', () => {
    // claudeOptionsSchema is .strip()ped, so an undeclared key vanishes silently.
    for (const retired of ['disable_tool_search', 'mcps:', 'hooks:']) {
      expect(shippedText()).not.toContain(retired);
    }
  });
});
