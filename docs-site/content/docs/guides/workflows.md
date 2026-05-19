---
title: Workflow examples
description: Illustrative YAML workflows showing phases, gates, and feedback loops.
icon: account_tree
weight: 310
toc: true
---

The examples below are **invented previews** of how Heimdall workflows might look. They are not wired to a live engine yet — they demonstrate structure, gates, and code blocks in the docs theme.

## Collect user input to file

A simple workflow that prompts for content and writes it to a file:

```yaml
name: collect-user-input
description: Prompt for text and save it to a file in the worktree.

phases:
  - id: prompt
    agent: input-collector
    prompt: |
      Ask the user what they want to save, then write the response
      to `output/user-notes.md` in the worktree.

  - id: verify
    gate: file-exists
    path: output/user-notes.md
```

Run it (preview):

```bash
heimdall workflow run collect-user-input
```

## Save content to file

```yaml
name: save-content
description: Take structured content from an agent and persist it.

phases:
  - id: draft
    agent: content-writer
    artifacts:
      - output/draft.md

  - id: approve
    gate: human-approval
    message: Review output/draft.md before finalizing.

  - id: commit
    command: git add output/draft.md && git commit -m "docs: add draft content"
```

## TDD cycle

A workflow with explicit review and retry paths:

```yaml
name: tdd-cycle
description: Write a spec, stub tests, implement, and iterate until green.

phases:
  - id: spec
    agent: spec-writer
    artifacts:
      - spec.md

  - id: stub
    agent: ts-stub-writer
    artifacts:
      - test/**/*.test.ts

  - id: implement
    agent: ts-engineer
    artifacts:
      - src/**

  - id: test
    command: npm run test:unit
    on_failure: implement

  - id: review
    agent: ts-test-reviewer
    on_failure: implement
```

Agent definitions might live alongside the workflow:

```markdown
<!-- agents/spec-writer.md -->
You are a specification writer. Given a task description, produce a concise
spec.md with acceptance criteria and edge cases. Do not write implementation code.
```

## TypeScript gate example

Illustrative CLI output when a validation gate fails:

```typescript
// Thrown by the workflow engine when a gate fails
throw new CliError({
  code: "GATE_FAILED",
  message: "Phase 'test' failed: npm run test:unit exited with code 1",
  exitCode: 1,
  details: {
    phase: "test",
    command: "npm run test:unit",
    retryPhase: "implement",
  },
});
```

## Parallel runs

Because each run uses an isolated worktree, you can fix multiple issues concurrently:

```bash
heimdall workflow run fix-issue --issue 12 &
heimdall workflow run fix-issue --issue 34 &
wait
```

Worktrees are created under `.heimdall/worktrees/` and cleaned up when runs complete or are cancelled.

## See also

- [About Heimdall](/docs/about/) — product overview and architecture
- [Getting started](/docs/getting-started/) — install and first run (preview)
