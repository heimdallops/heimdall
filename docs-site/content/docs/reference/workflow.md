---
title: Workflow schema
description: Root fields and structure of a Heimdall workflow definition.
icon: description
weight: 410
toc: true
---

{{< alert context="info" text="The workflow engine is not yet released. This reference reflects the planned schema." />}}

A Heimdall workflow is a YAML file. Only `name` and `nodes` are required; everything else is
optional.

## Root fields

| Field              | Type   | Required | Description                                                   |
| ------------------ | ------ | -------- | ------------------------------------------------------------- |
| `name`             | string | Yes      | Workflow identifier. Min 1 character.                         |
| `nodes`            | array  | Yes      | Ordered list of nodes to execute. Min 1 item.                 |
| `description`      | string | No       | Human-readable description.                                   |
| `version`          | string | No       | Workflow definition version string.                           |
| `platform`         | string | No       | Default agentic platform. Currently `"claude"`.               |
| `platform_options` | object | No       | Default platform options for all agentic nodes.               |
| `inputs`           | object | No       | Runtime parameters callers supply when starting the workflow. |
| `vars`             | object | No       | Static variables available to all nodes.                      |
| `workspace`        | object | No       | Controls the execution environment.                           |

## inputs

Declare parameters that must be provided at runtime. Each key is one input.

```yaml
inputs:
  issue_number:
    type: integer
    description: GitHub issue to resolve.
  branch_prefix:
    type: string
    default: fix
```

| Field         | Required | Description                                             |
| ------------- | -------- | ------------------------------------------------------- |
| `type`        | Yes      | One of `string`, `number`, `integer`, `boolean`.        |
| `description` | No       | Shown when prompting for the value.                     |
| `default`     | No       | Used when the input is not supplied. Must match `type`. |

Reference inputs in expressions as `inputs.<key>`. The engine fails before any node runs if a
required input is missing and has no `default`.

## vars

Static key/value pairs available to all nodes. Values must be `string`, `number`, `integer`,
or `boolean`.

```yaml
vars:
  repo: heimdallops/heimdall
  test_command: npm run quality
```

Reference vars in expressions as `vars.<key>`.

## workspace

| Field      | Type    | Default | Description                                                   |
| ---------- | ------- | ------- | ------------------------------------------------------------- |
| `worktree` | boolean | `true`  | When true, runs the workflow inside an isolated git worktree. |

With `worktree: true` (the default), the engine creates a temporary worktree under
`.heimdall/worktrees/` and tears it down after the run completes. Set `worktree: false` to run
in the current working directory instead.

## platform_options (Claude)

When `platform: claude`, the following options are accepted at the workflow level and can be
overridden per node.

| Field                 | Type            | Description                                             |
| --------------------- | --------------- | ------------------------------------------------------- |
| `model`               | string          | Default model for agentic nodes.                        |
| `reasoning_effort`    | string          | `low`, `medium`, `high`, or `max`.                      |
| `allowed_tools`       | string[]        | Built-in tools Claude may use.                          |
| `denied_tools`        | string[]        | Tools Claude cannot use, applied after `allowed_tools`. |
| `system_prompt`       | string          | Override the default system prompt.                     |
| `max_budget_usd`      | number          | USD cost cap; nodes fail if exceeded.                   |
| `mcps`                | string / object | MCP server config or path to a JSON config file.        |
| `disable_tool_search` | boolean         | Disable autodiscovery of tools. Recommended: `true`.    |
| `skills`              | string[]        | Skills to preload.                                      |
| `agents`              | string[]        | Paths to subagent definitions.                          |

## Full example

```yaml
name: fix-issue
description: Triage, implement, validate, and open a PR.
version: '1'

platform: claude
platform_options:
  model: claude-opus-4-7
  disable_tool_search: true
  allowed_tools: [Bash, Edit, Read, Write]

inputs:
  issue_number:
    type: integer
    description: GitHub issue number to resolve.

vars:
  test_command: npm run quality

workspace:
  worktree: true

nodes:
  - id: plan
    agent: spec-planner
    instructions: Analyze issue ${{ inputs.issue_number }} and produce a plan.

  - id: implement
    depends_on: [plan]
    agent: ts-engineer

  - id: validate
    depends_on: [implement]
    bash: ${{ vars.test_command }}

  - id: publish
    depends_on: [validate]
    bash: gh pr create --fill
```

## See also

- [Node types](/docs/reference/nodes/) — all node types and their fields
- [Expressions](/docs/reference/expressions/) — CEL syntax and available contexts
- [Workflow examples](/docs/guides/workflows/) — annotated workflow patterns
