---
name: spec-to-github-issues
description: >
  Create structured GitHub Issues from tasks.md, with correct dependency wiring and workstream
  sub-issues. Use this skill whenever the user wants to turn a feature spec into GitHub Issues,
  or create tracked tickets from a tasks.md file. Trigger on "create GitHub issues from the
  spec", "publish this spec to GitHub", "turn tasks.md into tickets", or any request to
  convert local spec artifacts into a set of linked GitHub Issues.
---

# Spec → GitHub Issues

Convert a local spec directory into a set of structured, dependency-linked GitHub Issues.

## What This Skill Produces

- One GitHub Issue per phase; phases with multiple workstreams also get one child sub-issue
  per workstream (the parent holds shared context — goal, independent test, checkpoint —
  and the children each hold one workstream's tasks)
- Issues linked by real GitHub issue numbers in their "Depends On" sections

## Inputs to Collect

Before doing any work, confirm these three things with the user if not already stated:

1. **Spec directory** — local path (e.g. `specs/002-workflow-engine`)
2. **Target GitHub repo** — e.g. `heimdallops/backlog`
3. **Feature name prefix** — used in issue titles, e.g. `"Workflow Engine"`

## Execution Steps

### Step 1: Read the spec directory

List all files recursively (`find <spec-dir> -type f | sort`). Read every file — at minimum
`tasks.md`, `spec.md`, and `plan.md`. Also read `data-model.md`, `research.md`, `quickstart.md`,
and anything under `contracts/` if present. You need the full picture to write meaningful issue
bodies.

### Step 2: Plan the issue structure

Read `tasks.md` and map each phase to its issue structure:

**Single-workstream phase** → one flat issue. All tasks go inline in the issue body.

**Multi-workstream phase** → one parent issue + one child sub-issue per workstream.
- The parent holds everything that doesn't belong to any individual workstream: the phase
  goal, independent test, checkpoint, and a list of links to the child sub-issues.
- Each child sub-issue holds only the tasks for its workstream.

For each phase, record:
- Phase title and description
- Whether it is single- or multi-workstream
- For multi-workstream: list of workstream names and their tasks
- Which prior phases must be **fully complete** before this phase can begin
  (hard blockers only — not merely related)

**Dependency rule**: Phases that can run in parallel share the same upstream dependencies
and do NOT list each other as dependencies. If Phase 5, 6, and 7 can all start once Phase 4
is done, each lists only Phase 4 as a dependency.

### Step 3: Create issues in dependency order

Create issues in dependency order so every referenced issue number is known before it is
cited. For every dependency edge A → B, create A before B. Phases with no dependencies can
be created first; parallel phases (those sharing the same upstream) can be created in any
order relative to each other.

#### Single-workstream phase

```bash
gh issue create \
  --repo <owner>/<repo> \
  --title "<Feature Name> - Phase <N>: <Phase Title>" \
  --body "$(cat <<'EOF'
<1–3 sentences: what this phase delivers and why it matters>

**Tasks**:
- [ ] T### <task description>
- [ ] T### <task description>

**Checkpoint**: <checkpoint text from tasks.md>

**Depends On**:
- [ ] #<N> — Phase <N>: <Title>

_(or "**Depends On**: None")_
EOF
)"
```

#### Multi-workstream phase — parent issue

Create the parent first to get its issue number, then create sub-issues that reference it.

```bash
gh issue create \
  --repo <owner>/<repo> \
  --title "<Feature Name> - Phase <N>: <Phase Title>" \
  --body "$(cat <<'EOF'
<1–3 sentences: what this phase delivers and why it matters>

**Goal**: <goal from tasks.md>
**Independent Test**: <independent test from tasks.md, if present>

**Workstreams** (sub-issues — can be worked in parallel):
- [ ] #TBD — <Workstream name>
- [ ] #TBD — <Workstream name>

**Checkpoint**: <checkpoint text from tasks.md>

**Depends On**:
- [ ] #<N> — Phase <N>: <Title>

_(or "**Depends On**: None")_
EOF
)"
```

Record the parent issue number. Then create each workstream sub-issue:

```bash
gh issue create \
  --repo <owner>/<repo> \
  --title "<Feature Name> - Phase <N> / <Workstream Name>" \
  --body "$(cat <<'EOF'
Part of #<parent-issue-number> — <Phase Title>

**Tasks**:
- [ ] T### <task description>
- [ ] T### <task description>
EOF
)"
```

After creating all sub-issues, edit the parent to replace `#TBD` references with the real
sub-issue numbers:

```bash
gh issue edit <parent-issue-number> \
  --repo <owner>/<repo> \
  --body "$(cat <<'EOF'
<updated body with real sub-issue numbers>
EOF
)"
```

Record all issue numbers for use in later phases' "Depends On" sections. When a later phase
depends on a multi-workstream phase, it depends on the **parent** issue — not the individual
sub-issues.

### Step 4: Report

After all issues are created, output a summary table:

```
| Issue      | Phase | Title                        | Depends On |
|------------|-------|------------------------------|------------|
| #12        | 1     | Install Dependencies         | None       |
| #13        | 2     | Error Types                  | #12        |
| #14        | 3     | User Story 1: Workflow Run   | #13        |
|   #15      | 3/ws  |   ↳ Data model               | (parent)   |
|   #16      | 3/ws  |   ↳ CLI command              | (parent)   |
| #17        | 4     | User Story 2: ...            | #13        |
...
```

Then print all issue URLs as a list so the user can open them directly.

## Issue Body Guidelines

**Phase description**: Write a clear goal sentence — what this phase delivers and why it
matters. For user-story phases, include the goal and independent test from tasks.md on the
parent issue.

**Tasks checklist**: Copy the exact task text from tasks.md. Preserve task IDs (T###).
Strip `[US#]` markers — they're internal planning notation, not needed in issue bodies.

**Depends On**: Only list hard blockers — phases fully complete before this one can begin.
Write `**Depends On**: None` if there are none. Later phases that depend on a multi-workstream
phase depend on the parent issue, not the sub-issues.

## Common Pitfalls to Avoid

- **Don't create a phase issue before its dependencies have issue numbers.** Dependency
  references use real `#N` GitHub issue numbers — create in order.
- **Don't list parallel phases as dependencies of each other.** Phases that share the same
  upstream dependency are siblings — they depend on the upstream, not on each other.
- **Don't put phase-level context in sub-issues.** Goal, independent test, and checkpoint
  belong on the parent. Sub-issues hold only their workstream's tasks.
- **Don't create sub-issues for a single-workstream phase.** Only split into parent + children
  when there are genuinely independent workstreams someone else could pick up in parallel.
- **Don't forget to edit the parent** to replace `#TBD` with real sub-issue numbers after
  creating the children.
