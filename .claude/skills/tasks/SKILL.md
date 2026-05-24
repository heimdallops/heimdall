---
name: tasks
description: >
  Generate an actionable, dependency-ordered task breakdown from a feature plan. Use this skill
  after /plan to produce tasks.md with concrete, file-level tasks organized by user story.
  Trigger on "break into tasks", "generate tasks", "create a task list", "task it out", or any
  request to decompose a plan into discrete implementation steps.
---

# Tasks

Generate `tasks.md` — an actionable, dependency-ordered task list organized by user story and
structured around **workstreams**. This is the third step in the specify → plan → tasks →
implement workflow.

## Core Concepts

**Workstream**: A named sequence of tasks that must run in order. Tasks within a workstream
have internal dependencies — they cannot be parallelized. Example: "Data model" is a workstream
where the entity must exist before the repository, and the repository before the service.

**Phase**: A group of workstreams that collectively deliver a coherent increment (a user story,
the foundational layer, etc.). Workstreams within a phase can be worked in parallel by different
engineers or agents because they touch different files. A phase is complete only when all its
workstreams are complete.

**Inter-phase dependency**: If workstream B depends on output from workstream A, they belong in
separate phases with B's phase ordered after A's. Phases with no dependency relationship can run
in parallel — two unrelated user story phases, for example, can be worked simultaneously.

The result: parallelism is structural — work any workstream in the current phase simultaneously.

## Execution Steps

### 1. Locate design artifacts

Resolve the active feature directory using this priority order:

1. **User-specified**: If the user named a specific feature or NNN number in their message, use
   `specs/<matching-dir>/`.
2. **`specs/.feature.json`**: If the file exists, read `feature_directory` from it and use that
   path. This is the normal case after running `/specify`.
3. **Fallback**: If neither applies, scan `specs/` and use the directory with the highest NNN
   prefix. Warn the user that `.feature.json` is missing and suggest running `/specify` to set it.

Load:

- **Required**: `specs/<feature-dir>/plan.md` and `specs/<feature-dir>/spec.md`
- **Optional**: `specs/<feature-dir>/data-model.md`, `specs/<feature-dir>/contracts/`,
  `specs/<feature-dir>/research.md`, `specs/<feature-dir>/quickstart.md`

If `plan.md` or `spec.md` are missing, tell the user to run `/plan` first.

### 2. Extract task inputs

From `spec.md`:

- User stories with their priorities (P1, P2, P3...)
- Acceptance criteria per story

From `plan.md`:

- Tech stack and file structure
- New files to create and existing files to modify
- Architecture layers (commands, services, models, etc.)

From `data-model.md` (if present):

- Entities → map to the earliest user story that needs them

From `contracts/` (if present):

- Interface contracts → map to the user story they serve

### 3. Identify workstreams

Before writing any tasks, map out the workstreams for each phase:

1. **List the files** that need to change or be created for this phase.
2. **Group files by dependency chain** — files that must be written in sequence form one
   workstream. Files that are independent of each other form separate workstreams.
3. **Name each workstream** after the concern it owns (e.g., "Data model", "Auth middleware",
   "CLI command", "Tests").
4. **Check for cross-workstream dependencies**: if workstream B needs a type or function from
   workstream A to compile, they cannot be in the same phase — A belongs in an earlier phase.

Common workstream splits within a user story phase:
- `Data model` (entities, schema migrations) → `Service layer` → `Command / handler` are
  often three sequential phases, not one, because each layer imports the previous
- `Tests` can be a parallel workstream within a phase if they only import stable interfaces
- `Config / schema changes` are often their own workstream since many files touch them

### 4. Generate tasks.md

Write `specs/<feature-dir>/tasks.md` following the structure below.

**Every task MUST follow this exact format**:

```
- [ ] T### [US#] Description with exact file path
```

- `- [ ]` — always present (markdown checkbox)
- `T###` — sequential number (T001, T002, ...) globally across the whole file, in the order a
  single engineer would execute them (top-to-bottom through phases, left-to-right workstream
  order within a phase)
- `[US#]` — REQUIRED for user story phase tasks (US1, US2, ...) — omit for Setup/Foundational/Polish
- Description — concrete action + exact file path

Parallelism is expressed structurally: any two tasks in different workstreams within the same
phase can run in parallel.

**Phase and workstream structure**:

```markdown
# Tasks: [FEATURE NAME]

**Spec**: specs/<feature-dir>/spec.md
**Plan**: specs/<feature-dir>/plan.md

---

## Phase 1: Setup

**Purpose**: Project initialization and shared infrastructure
**Workstreams**: [list workstream names, e.g. "Dependencies · Config schema"]

### Workstream: Dependencies

- [ ] T001 Add X package to package.json

### Workstream: Config schema

- [ ] T002 Add configKey to src/config/schema.ts

---

## Phase 2: Foundational

**Purpose**: Blocking prerequisites — must complete before any user story
**Workstreams**: [list workstream names]

⚠️ No user story work begins until this phase is complete.

### Workstream: [Name]

- [ ] T00N [description with file path]
- [ ] T00N [description with file path]

**Checkpoint**: Foundation ready — user story work can begin.

---

## Phase 3: User Story 1 — [Title] (Priority: P1) 🎯 MVP

**Goal**: [What this story delivers]
**Independent Test**: [How to verify this story alone]
**Workstreams**: [list workstream names — these can run in parallel]

### Workstream: [Name, e.g. "Data model"]

- [ ] T00N [US1] Define entity in src/core/models/foo.ts
- [ ] T00N [US1] Add repository in src/services/foo-repo.ts

### Workstream: [Name, e.g. "CLI command"]

- [ ] T00N [US1] Scaffold command in src/commands/foo/command.ts
- [ ] T00N [US1] Implement run logic in src/commands/foo/run.ts

**Checkpoint**: User Story 1 fully functional and independently testable.

---

## Phase 4: User Story 2 — [Title] (Priority: P2)

**Goal**: [What this story delivers]
**Independent Test**: [How to verify this story alone]
**Workstreams**: [list workstream names]

[Repeat pattern]

---

## Phase N: Polish & Cross-Cutting Concerns

**Workstreams**: [list workstream names]

### Workstream: Documentation

- [ ] T### Update README / docs with file path

### Workstream: Cleanup

- [ ] T### [description with file path]

---

## Execution Guide

### Phase dependencies

Phases are sequential only when one depends on another. Phases with no dependency between them
can run in parallel.

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Depends on Setup — blocks all user stories
- **User Story phases**: All depend on Foundational; independent user story phases can run in
  parallel with each other
- **Polish**: Depends on all desired user story phases complete

### Workstream parallelism

Within each phase, workstreams are independent and can be assigned to different engineers or
agents simultaneously. A workstream's tasks must be completed in listed order.

**Example parallel execution for Phase 3:**
- Engineer A takes "Data model" workstream
- Engineer B takes "CLI command" workstream
- Both finish, then either can tackle "Tests" workstream if it appears in the same phase

### MVP scope

1. Complete Phase 1 (Setup)
2. Complete Phase 2 (Foundational)
3. Complete Phase 3 (User Story 1)
4. Validate independently — stop and demo if ready

### Incremental delivery

P1 complete → validate → P2 complete → validate → ... → Polish
Each story adds value without breaking previous stories.
```

### 5. Validate task quality

Check every task and workstream:

- Every task has a checkbox, sequential ID, and file path
- User story tasks have `[US#]` label
- Tasks within a workstream have a real dependency chain — if two tasks don't actually depend on
  each other, they should be in separate workstreams
- Tasks in separate workstreams within the same phase genuinely do not import from each other
- Each user story phase is a complete, independently testable increment
- No task is vague (e.g., "implement feature" without a file path)
- Task ordering within each workstream respects actual dependencies (no integration before model)
- Phase boundaries reflect real blocking dependencies, not just logical grouping

Fix any violations before writing the file.

### 6. Report

Output:

- Path to `tasks.md`
- Total task count
- Workstream count and names per phase
- Which workstreams can run in parallel (and in which phase)
- MVP scope (Phase 1 + Phase 2 + Phase 3 = User Story 1)
- Suggested next step: `/analyze` to validate consistency, or start implementing Phase 1

## Task Generation Rules

**Organize by user story** — this is the primary constraint. Every implementation task maps to
a user story so stories can be developed and tested independently.

**Workstreams express real dependency structure** — a workstream is not just a category label.
It means: these tasks must happen in sequence because each depends on the previous. If you find
yourself with a single-task workstream, that's fine — it means that concern is independent of
all others in this phase.

**Tests are optional** — only add test tasks if the user explicitly requests TDD or the spec
requires test coverage. When included, tests form their own workstream within the relevant phase
if they only depend on stable interfaces, or appear in a later phase if they depend on multiple
workstreams completing first.

**Foundational tasks** are truly shared prerequisites: database schema setup, auth middleware,
base entity classes that multiple stories need. If something is only needed by one story, it
belongs in that story's phase.

**File paths must be concrete** — use the project structure from `plan.md`. Tasks without file
paths are not executable by an LLM and must be revised.

**When in doubt, split phases rather than workstreams** — it is safer to put a dependency
boundary between phases than to assume two workstreams are truly independent. A false parallel
assumption causes merge conflicts and broken builds; an extra phase boundary only costs a small
coordination step.
