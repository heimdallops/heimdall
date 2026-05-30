---
title: Getting started
description: How you will install and run Heimdall once the CLI is released.
icon: rocket_launch
weight: 200
toc: true
---

## Prerequisites

When the CLI ships, you will need:

- **Node.js** 22 or later
- **Git** with worktree support
- A repository where agents will make changes

## Install (preview)

Installation instructions are not finalized. The intended experience will look like:

```bash
npm install -g heimdall
heimdall --version
```

## Initialize a workflow

Create a `workflows/` directory in your repository and add a workflow definition:

```yaml
# workflows/fix-issue/workflow.yaml
name: fix-issue
description: Triage, implement, validate, and open a PR for an issue.

nodes:
  - id: plan
    agent: spec-planner

  - id: approve_plan
    depends_on: [plan]
    approval:
      message: 'Review the plan before implementing. Approve to continue.'
      exit_on_no: true

  - id: implement
    depends_on: [approve_plan]
    agent: ts-engineer

  - id: validate
    depends_on: [implement]
    bash: npm run quality

  - id: review
    depends_on: [validate]
    agent: ts-code-reviewer

  - id: publish
    depends_on: [review]
    bash: gh pr create --fill
```

{{< alert context="info" text="This YAML is illustrative. The workflow engine is not yet released." />}}

## Run a workflow

```bash
# Run against the current repo; Heimdall creates an isolated worktree
heimdall workflow run fix-issue --issue 42

# Inspect run status
heimdall workflow status --run-id wf_01HXYZ
```

Each run gets its own git worktree under `.heimdall/worktrees/`, keeping parallel agent tasks isolated.

## Configuration

Shared config will load from defaults, a config file, environment variables, and CLI flags (highest precedence last):

```toml
# .heimdallrc.toml (example)
default_branch = "main"
worktree_root = ".heimdall/worktrees"
verbose = false
```

```bash
export HEIMDALL_VERBOSE=true
heimdall workflow run fix-issue --verbose
```

## Next steps

- Read [About Heimdall](/docs/about/) for the full product overview
- Browse [Workflow examples](/docs/guides/workflows/) for sample YAML and agent phases
