import { describe, expect, it } from 'vitest';

import { CLI_VERSION, listSkills } from '../../../../src/core/skills/index.ts';

describe('skill catalog', () => {
  it('exposes the generated bundle', () => {
    // A missing or empty bundle means the generate:skills prebuild step did not run; failing
    // here is clearer than shipping an install that writes nothing.
    const skills = listSkills();

    expect(skills.length).toBeGreaterThan(0);
  });

  it('includes the workflow-authoring skill with body and references', () => {
    const skill = listSkills().find((candidate) => candidate.name === 'heimdall-workflows');

    expect(skill).toBeDefined();
    expect(skill?.description).not.toBe('');
    expect(skill?.body).toContain('Heimdall Workflows');
    expect(skill?.references.length).toBeGreaterThan(0);
  });

  it('bundles the workflow schema as a reference', () => {
    const skill = listSkills().find((candidate) => candidate.name === 'heimdall-workflows');
    const workflowSchema = skill?.references.find((ref) => ref.path === 'workflow.yaml');

    expect(workflowSchema?.contents).toContain('Root schema for a Heimdall workflow definition');
  });

  it('exposes a non-empty CLI version for stamping installed files', () => {
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
