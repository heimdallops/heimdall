import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { RESERVED_IDS } from '../../../../src/core/engine/nodes/base.ts';
import { listSkills } from '../../../../src/core/skills/index.ts';

// Nothing in the engine fails when the skill's prose drifts from what the engine binds, so
// these pin the two together. About vocabulary, not phrasing: a namespace change breaks them,
// a reworded sentence does not.

const skill = (): NonNullable<ReturnType<typeof listSkills>[number]> => {
  const found = listSkills().find((candidate) => candidate.name === 'heimdall-workflows');

  if (found === undefined) {
    throw new Error('heimdall-workflows skill is absent from the bundle');
  }

  return found;
};

const shippedText = (): string => skill().body;

const yamlExamples = (): string[] =>
  [...skill().body.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');

// Examples only: the prose names retired spellings on purpose, to tell an agent what to avoid.
const usageSites = (): { label: string; text: string }[] =>
  yamlExamples().map((text, index) => ({ label: `example ${index + 1}`, text }));

describe('skill content — expression namespace', () => {
  // Each pattern matches only the retired spelling, never the current one.
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
  // An unquoted ternary in a bare-CEL value fails to parse before Heimdall ever sees it.
  it('parses every YAML example in the skill body', () => {
    const blocks = [...skill().body.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1]);

    expect(blocks.length).toBeGreaterThan(0);

    for (const block of blocks) {
      expect(() => load(block ?? '')).not.toThrow();
    }
  });

  it('renders every field-reference table with a complete header row', () => {
    // A malformed row renders as literal pipes rather than a table.
    const rows = skill()
      .body.split('\n')
      .filter((line) => line.trim().startsWith('|'));

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.trim().endsWith('|'), row).toBe(true);
    }
  });
});

// Vocabulary checks cannot catch a claim that is well-spelled and wrong. Each of these was
// misstated once and would have produced a workflow that fails at runtime.
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

    expect(skill().body).not.toMatch(claimsParsing);
  });

  it('names no platform option the Claude adapter would discard', () => {
    // claudeOptionsSchema is .strip()ped, so an undeclared key vanishes silently.
    for (const retired of ['disable_tool_search', 'mcps:', 'hooks:']) {
      expect(shippedText()).not.toContain(retired);
    }
  });
});
