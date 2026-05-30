---
title: Expressions
description: CEL expression syntax and available contexts in Heimdall workflows.
icon: code
weight: 430
toc: true
---

{{< alert context="info" text="The workflow engine is not yet released. This reference reflects the planned schema." />}}

Heimdall uses [CEL (Common Expression Language)](https://github.com/google/cel-spec) for
dynamic values in workflow YAML. Wrap an expression in `${{ }}` to interpolate it.

## Syntax

```yaml
bash: echo ${{ inputs.issue_number }}
instructions: Review the output at ${{ heimdall.session_dir }}/plan.md.
approval:
  message: Approve to commit ${{ needs.draft.output }}.
```

The `if` field and loop `until` and `outputs` expressions are plain CEL — do **not** wrap them
in `${{ }}`:

```yaml
if: 'needs.validate.output == "pass"'
loop:
  until: 'scope.nodes.test.output == "pass"'
```

## Supported fields

`${{ }}` interpolation is supported in:

- `bash` (bash node script text)
- `env` values (bash node environment variables)
- `instructions` (agent node)
- `prompt` (prompt node)
- `prompt_file` path (prompt_file node)
- `approval.message`

Plain CEL (no `${{ }}`) is used in:

- `if` (all nodes)
- `loop.until`
- `loop.outputs` values

## Available contexts

### inputs

Resolved values of the workflow's declared `inputs`. Shape and type match what was declared.

```yaml
# Access a declared input
bash: gh issue view ${{ inputs.issue_number }}
```

### vars

Resolved values of the workflow's declared `vars`.

```yaml
# Access a static variable
bash: ${{ vars.test_command }}
```

### needs

Outputs of completed upstream nodes, keyed by node `id`. A node can only reference nodes it
directly or transitively depends on via `depends_on`.

```yaml
- id: summarize
  depends_on: [draft]
  prompt: Summarize this in one paragraph:${{ needs.draft.output }}
```

**Output shapes by node type:**

| Node type            | Access pattern               | Value                                      |
| -------------------- | ---------------------------- | ------------------------------------------ |
| `bash` (text)        | `needs.<id>.output`          | Plain string (trailing newlines stripped). |
| `bash` (json)        | `needs.<id>.output.<field>`  | Parsed JSON field.                         |
| `agent` / `prompt`   | `needs.<id>.output`          | Agent response string.                     |
| `agent` (structured) | `needs.<id>.output.<field>`  | Field from structured output object.       |
| `approval`           | `needs.<id>.output.approved` | `true` if approved, `false` if declined.   |
| `approval`           | `needs.<id>.output.feedback` | Feedback string (when `enable_feedback`).  |
| `loop`               | `needs.<id>.output.<key>`    | Value of a declared loop output key.       |

### heimdall

Runtime variables provided by the engine.

| Expression             | Type   | Description                                                         |
| ---------------------- | ------ | ------------------------------------------------------------------- |
| `heimdall.session_dir` | string | Absolute path to a temporary directory scoped to this run. Persists |
|                        |        | for the lifetime of the run. Use it to share files between nodes.   |

```yaml
- id: write_plan
  agent: spec-planner
  instructions: Write the plan to ${{ heimdall.session_dir }}/plan.md.

- id: read_plan
  depends_on: [write_plan]
  bash: cat ${{ heimdall.session_dir }}/plan.md
```

### scope (inside loops)

Inside a `loop` node's body, `until` expression, and `outputs` expressions, the `scope`
context is available. It is not accessible outside a loop — use `needs.<loop_id>.output`
there instead.

| Expression                | Type    | Description                                                                |
| ------------------------- | ------- | -------------------------------------------------------------------------- |
| `scope.iteration`         | integer | Iterations completed so far. Starts at 0, increments after each iteration. |
| `scope.nodes.<id>.output` | any     | Output of a child node from the most recently completed iteration.         |
| `scope.needs.<id>`        | object  | Output of a node declared in the loop's own `depends_on`.                  |
| `scope.outer`             | object  | Context of the immediately enclosing loop (nested loops only).             |

```yaml
loop:
  until: 'scope.nodes.test.output == "pass"'
  outputs:
    iterations_taken: 'scope.iteration + 1'
  nodes:
    - id: test
      bash: |
        npm run test:unit && echo "pass" > $HEIMDALL_OUTPUT || echo "fail" > $HEIMDALL_OUTPUT
```

For nested loops, `scope.outer` exposes the enclosing loop's `scope`, and
`scope.outer.outer` chains one level further for each additional nesting level.

## Skipped nodes

A node is skipped when its `if` expression evaluates to false, or when any of its `depends_on`
nodes were skipped. CEL is never evaluated for a skipped node, so expressions referencing a
skipped node's output are never reached.

## See also

- [Node types](/docs/reference/nodes/) — which fields support `${{ }}` per node type
- [Workflow schema](/docs/reference/workflow/) — `inputs`, `vars`, and `workspace` fields
- [Workflow examples](/docs/guides/workflows/) — end-to-end patterns using expressions
