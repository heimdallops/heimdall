---
name: plan
description: >
  Generate a technical implementation plan from a feature spec. Use this skill after /specify
  (and optionally /clarify) to produce the architecture, data model, and design artifacts needed
  before task breakdown. Trigger on "plan the implementation", "create a technical plan",
  "design the architecture for", or any request to move from requirements to technical design.
---

# Plan

Generate a technical implementation plan (`plan.md`) and supporting design artifacts from a
feature spec. This is the second step in the specify → plan → tasks → implement workflow.

## Execution Steps

### 1. Locate the spec

Resolve the active feature directory using this priority order:

1. **User-specified**: If the user named a specific feature or NNN number in their message, use
   `specs/<matching-dir>/`.
2. **`specs/.feature.json`**: If the file exists, read `feature_directory` from it and use that
   path. This is the normal case after running `/specify`.
3. **Fallback**: If neither applies, scan `specs/` and use the directory with the highest NNN
   prefix. Warn the user that `.feature.json` is missing and suggest running `/specify` to set it.

Load `specs/<feature-dir>/spec.md`. If it doesn't exist, tell the user to run `/specify` first.
Also load `CLAUDE.md` for project principles and constraints.

### 2. Determine technical context

Extract or infer:

- **Language/Runtime**: From `package.json`, file extensions, or existing source files
- **Primary dependencies**: From `package.json` or equivalent manifest
- **Testing framework**: From existing test files or config
- **Project type**: CLI / library / web service / etc.
- **Directory structure**: From existing `src/` layout

Mark anything unknown as "NEEDS CLARIFICATION" — resolve by inspecting the repo before asking
the user. Only ask the user if you genuinely cannot determine it from the codebase.

### 3. Research phase (Phase 0)

For each technical unknown or design decision implied by the spec:

- Research best practices for the relevant technology in this domain
- Consider alternatives and document tradeoffs
- Resolve all "NEEDS CLARIFICATION" items before writing the plan

Produce a `specs/<feature-dir>/research.md` with this format per decision:

```markdown
## [Decision Topic]

**Decision**: [What was chosen]
**Rationale**: [Why — performance, maintainability, consistency with codebase, etc.]
**Alternatives considered**: [What else was evaluated and why it was rejected]
```

### 4. Design phase (Phase 1)

**Data model** (`specs/<feature-dir>/data-model.md`):

- List each entity: name, fields, types, validation rules, relationships
- Document state transitions if applicable

**Interface contracts** (`specs/<feature-dir>/contracts/`):

- For each public interface the feature exposes (CLI commands, API endpoints, exported functions):
  - Define the contract: inputs, outputs, error cases
  - Format appropriately for the project type (CLI: command schema; API: endpoint spec; library: function signatures)
- Skip if the feature is purely internal

**Quickstart** (`specs/<feature-dir>/quickstart.md`):

- 3–5 concrete end-to-end scenarios that validate the feature works
- Written as manual test scripts or example invocations

### 5. Write plan.md

Create `specs/<feature-dir>/plan.md`:

````markdown
# Implementation Plan: [FEATURE NAME]

**Feature Directory**: `specs/<feature-dir>`
**Spec**: [link to spec.md]
**Date**: [DATE]

## Summary

[Primary requirement + chosen technical approach in 2–3 sentences]

## Technical Context

| Item             | Value                        |
| ---------------- | ---------------------------- |
| Language/Runtime | [e.g., TypeScript / Node 22] |
| Key Dependencies | [e.g., commander, zod, ink]  |
| Storage          | [e.g., filesystem / none]    |
| Testing          | [e.g., vitest]               |
| Project Type     | [CLI / library / service]    |

## Architecture

[Describe how the feature fits into the existing codebase — which modules it touches,
what new modules it adds, and how they interact. Reference concrete file paths.]

## Project Structure

Files created or modified by this feature:

```text
src/
  [path/to/new-file.ts]   — [purpose]
  [path/to/modified.ts]   — [what changes]
test/
  [path/to/test.ts]       — [what it covers]
```
````

## Design Decisions

[Summary of key decisions from research.md — 3–5 bullet points covering the most
important choices and why they were made]

## Constraints & Risks

[Technical constraints, known unknowns, and risks that implementation should account for]

```

### 6. Validate against CLAUDE.md principles

Check the plan against all principles in `CLAUDE.md`:
- YAGNI: No speculative abstractions, flags, or config keys
- KISS: No clever meta-programming where explicit control flow works
- SRP: Each new module has one clear responsibility
- Fail Fast: Error paths are explicit and use `CliError`

Flag any violations. Do not proceed with a plan that violates a MUST principle — revise it.

### 7. Report

Output:
- Paths to all generated artifacts (`plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`)
- Summary of architectural decisions
- Any open risks or constraints to watch during implementation
- Suggested next step: `/tasks` to generate the task breakdown

## Key Rules

- Use absolute paths for all file operations; use project-relative paths in documentation.
- Do not create abstractions that don't have a concrete current use case.
- The plan must be specific enough that `/tasks` can generate file-level tasks from it.
- If the spec has unresolved `[NEEDS CLARIFICATION]` markers, run `/clarify` first.
```
