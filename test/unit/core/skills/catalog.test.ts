import { describe, expect, it } from 'vitest';

import { CLI_VERSION, listSkills } from '../../../../src/core/skills/index.ts';

describe('skill catalog', () => {
  it('exposes the generated bundle', () => {
    // A missing or empty bundle means the generate:skills prebuild step did not run; failing
    // here is clearer than shipping an install that writes nothing.
    const skills = listSkills();

    expect(skills.length).toBeGreaterThan(0);
  });

  it('includes the workflow-authoring skill with a body', () => {
    const skill = listSkills().find((candidate) => candidate.name === 'heimdall-workflows');

    expect(skill).toBeDefined();
    expect(skill?.description).not.toBe('');
    expect(skill?.body).toContain('Heimdall Workflows');
  });

  it('carries its own field reference rather than pointing at files beside it', () => {
    // The skill installs as a single SKILL.md, so everything an agent needs is in the body.
    const skill = listSkills().find((candidate) => candidate.name === 'heimdall-workflows');

    expect(skill?.body).toContain('## Field reference');
    expect(skill?.body).not.toContain('references/');
  });

  it('exposes a non-empty CLI version for stamping installed files', () => {
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
