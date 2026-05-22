---
title: About Heimdall
description: What Heimdall is, the problems it solves, and how it fits into agentic development.
icon: info
weight: 100
toc: true
---

## Overview

Heimdall is a CLI for building **deterministic agentic workflows** from YAML. User-defined workflows describe the phases, gates, feedback loops, artifacts, and completion criteria that guide agentic work. Agents provide the intelligence; Heimdall owns the structure.

Each run executes in an **isolated git worktree**, so teams can run fixes and implementation tasks in parallel without mixing changes.

## The problem

AI agents are powerful, but the process around them is often implicit:

- Planning gets skipped or varies by who runs the agent
- Validation drifts between runs
- Feedback is handled inconsistently
- Handoffs miss team standards

Heimdall makes that process **explicit**. Workflows are versioned, reviewable artifacts — not tribal knowledge buried in chat logs.

<div style="margin: 1.75rem 0; border-radius: 8px; overflow: hidden; border: 1px solid #21262d;">
  <iframe src="/workflow-demo.html" style="width:100%; height:620px; border:none; display:block;" title="Heimdall workflow simulation" loading="lazy"></iframe>
</div>

## What Heimdall provides

| Capability | Description |
| ---------- | ----------- |
| **Deterministic structure** | YAML workflows define phases, gates, and artifacts |
| **Feedback loops** | Review, validation, correction, and retry paths are first-class |
| **Isolated execution** | Separate git worktrees per run for parallel work |
| **PR-ready paths** | Model flows from ticket intake through implementation, validation, review, and PR creation |
| **Complex process modeling** | Branching, iteration, and explicit handoffs — not just linear prompts |

## Design principles

Heimdall's implementation follows a small set of constraints:

- **YAGNI** — no speculative config or stubs without a concrete use case
- **KISS** — explicit control flow over clever meta-programming
- **Fail fast** — expected failures surface clearly; nothing is silently swallowed
- **Reversibility** — small, mergeable changes with an obvious rollback path

## Architecture (CLI)

The CLI is organized in layers:

```text
src/
  index.ts              # Entrypoint: argv parse + top-level error mapping
  cli/                  # Commander setup, context, middleware
  commands/<command>/   # Per-command parse + run
  core/                 # Domain logic (no CLI dependencies)
  services/             # Side-effect adapters (fs, process, api)
  config/               # Schemas and config loading
  output/               # Human/json output plumbing
  errors/               # Typed app errors
```

Commands parse and validate locally, then pass normalized input to `run(ctx, input)`. Shared runtime config is resolved once as `ctx.config`.

## Status

User-facing install and command reference are **not published yet**. The examples in this documentation site are illustrative previews of the workflow model and CLI ergonomics.

## License

Heimdall is [MIT licensed](https://github.com/heimdallops/heimdall/blob/main/LICENSE).
