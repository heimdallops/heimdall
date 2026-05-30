---
title: Execution model
description: How the Heimdall engine runs workflows — dependency order, parallelism, failure, and worktrees.
icon: schema
weight: 320
toc: true
---

{{< alert context="info" text="The workflow engine is not yet released. This page describes planned behavior." />}}

## Dependency order and parallelism

The engine builds a directed acyclic graph (DAG) from the `depends_on` fields in each node.
Nodes without declared dependencies are eligible to run immediately. As each node completes,
the engine dispatches any nodes whose dependencies are now satisfied.

Nodes with no shared dependency run **concurrently** — the engine does not serialize nodes
that could run in parallel.

```yaml
nodes:
  - id: lint # no depends_on — runs immediately
    bash: npm run lint

  - id: typecheck # no depends_on — runs concurrently with lint
    bash: npm run typecheck

  - id: report
    depends_on: [lint, typecheck] # waits for both to finish
    bash: echo "all checks passed"
```

The engine rejects workflows with cycles or references to nonexistent node IDs before any
node runs.

## Conditional skip

A node with an `if` field is skipped when the expression evaluates to false. Skip propagates
transitively: any node that depends on a skipped node is also skipped, even if its other
dependencies completed successfully.

```yaml
- id: publish
  depends_on: [validate]
  if: 'needs.validate.output == "pass"'
  bash: gh pr create --fill

- id: notify
  depends_on: [publish] # skipped because publish was skipped
  bash: echo "published"
```

CEL expressions on skipped nodes are never evaluated.

## Failure behavior

When a node fails, the engine stops dispatching new nodes. Any nodes that are already
running are allowed to finish naturally before the workflow is marked as failed. This is
distinct from an `exit` node, which cancels in-flight nodes immediately.

A `bash` node fails when its script exits with a non-zero exit code. An agentic node fails
when the platform adapter returns an error.

If a node has a `retries` policy, the engine retries it up to `max_attempts` additional
times using exponential backoff before recording the final failure.

## Approval gates

When the engine reaches an `approval` node, it emits an event and pauses. Execution of
downstream nodes does not begin until an external caller (CLI, TUI, or web UI) resolves
the approval.

With `exit_on_no: true`, a declined approval immediately terminates the workflow. Without
it, `needs.<id>.output.approved` is `false` and downstream nodes can route on that value.

## Platform adapters

Agentic nodes (`agent`, `prompt`, `prompt_file`) are dispatched to a **platform adapter**.
The engine does not call the AI model directly — the adapter owns resolution, invocation, and
response parsing. This keeps the engine decoupled from any specific AI platform.

The default platform is Claude Code (`platform: claude`). Each agentic node inherits
workflow-level `platform` and `platform_options`, with node-level overrides taking precedence.

Agent names (bare strings in `agent:`) are resolved by the adapter using the platform's
standard search path: project `.claude/agents/` before global `~/.claude/agents/`.

## Session continuity

By default each agentic node starts a fresh session (`context: clean`). Setting
`context: shared` on a node tells the adapter to continue the session from the immediately
preceding agentic node. This is useful when a follow-up prompt should have access to the
prior conversation without repeating context.

`context: shared` is only valid when `depends_on` references a single agentic predecessor.
The engine rejects the workflow at startup if a shared-context node has multiple agentic
predecessors.

## Worktree isolation

When `workspace.worktree` is `true` (the default), each run gets its own git worktree under
`.heimdall/worktrees/`. This means parallel runs do not touch each other's files or the main
working tree.

After a run completes:

- **No uncommitted changes** — the worktree is removed automatically.
- **Uncommitted changes remain** — the engine emits a warning with the worktree path and
  leaves it in place so you can inspect or commit the work.
- **Failed run** — the worktree and run directory are always preserved for debugging,
  regardless of whether there are uncommitted changes.

Running in a non-git directory with `workspace.worktree: true` is an engine error.

## Loops

A `loop` node re-runs its inner node list on each iteration. The engine respects `depends_on`
within the loop body the same way it does at the top level — inner nodes run in dependency
order and concurrently where possible.

After each iteration, the engine evaluates the `until` expression. When it returns true, or
when `max_iterations` is reached, the loop exits. Reaching `max_iterations` without `until`
ever becoming true is a normal (non-failure) exit.

A `break` node inside a loop exits the loop immediately at that point in the iteration.

## See also

- [Node types](/docs/reference/nodes/) — all node types and their fields
- [Expressions](/docs/reference/expressions/) — CEL syntax and available contexts
- [Workflow examples](/docs/guides/workflows/) — end-to-end patterns
