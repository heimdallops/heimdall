---
title: Node types
description: All eight Heimdall node types and their fields.
icon: account_tree
weight: 420
toc: true
---

{{< alert context="info" text="The workflow engine is not yet released. This reference reflects the planned schema." />}}

Every entry in a workflow's `nodes` list is one of eight node types, identified by its
discriminating field (`bash`, `agent`, `prompt`, `prompt_file`, `approval`, `exit`, `loop`,
`break`). All nodes share a set of base fields.

## Base fields (all nodes)

| Field        | Type   | Required | Description                                                             |
| ------------ | ------ | -------- | ----------------------------------------------------------------------- |
| `id`         | string | Yes      | Unique identifier. Alphanumeric and underscores only (`[a-zA-Z0-9_]+`). |
| `name`       | string | No       | Human-readable display name. Falls back to `id` when omitted.           |
| `depends_on` | array  | No       | IDs of nodes that must complete before this node runs.                  |
| `if`         | string | No       | CEL expression. Node is skipped when the expression evaluates to false. |
| `timeout`    | number | No       | Milliseconds before the node times out and fails.                       |
| `retries`    | object | No       | Retry policy applied on failure.                                        |

### retries

| Field              | Type    | Description                                                     |
| ------------------ | ------- | --------------------------------------------------------------- |
| `max_attempts`     | integer | Maximum number of retry attempts (≥ 0).                         |
| `initial_delay_ms` | integer | Initial delay before the first retry. Uses exponential backoff. |
| `max_delay_ms`     | integer | Maximum delay between retry attempts.                           |

---

## bash

Executes a shell script. Write to `$HEIMDALL_OUTPUT` to expose output to downstream nodes.
Incidental stdout from the script does not become the node's output — only the contents of
`$HEIMDALL_OUTPUT` are captured.

```yaml
- id: run_tests
  bash: |
    if npm run test:unit; then
      echo "pass" > $HEIMDALL_OUTPUT
    else
      echo "fail" > $HEIMDALL_OUTPUT
    fi
```

| Field           | Type             | Required | Description                                                                 |
| --------------- | ---------------- | -------- | --------------------------------------------------------------------------- |
| `bash`          | string           | Yes      | Shell script to execute. Supports `${{ }}` interpolation.                   |
| `env`           | object           | No       | Key/value pairs injected as environment variables. Values support `${{ }}`. |
| `output_format` | `text` \| `json` | No       | How `$HEIMDALL_OUTPUT` is parsed (default: `text`).                         |

With `output_format: json`, the file contents are parsed as JSON and its fields are accessible
as `needs.<id>.output.<field>`. The node fails immediately if the contents are not valid JSON.

A non-zero exit code always fails the node; JSON parsing is skipped when the exit code is
non-zero.

---

## agent

Runs a named or file-based agent via the platform adapter. Agent files follow the YAML
frontmatter convention — frontmatter supplies platform options; the body is the system prompt.

```yaml
- id: implement
  depends_on: [plan]
  agent: ts-engineer
  instructions: Focus on the files listed in ${{ needs.plan.output }}.
```

| Field              | Type              | Required | Description                                                              |
| ------------------ | ----------------- | -------- | ------------------------------------------------------------------------ |
| `agent`            | string            | Yes      | Agent name or path. Bare names are resolved by the platform adapter.     |
| `instructions`     | string            | No       | Additional instructions appended to the agent prompt. Supports `${{ }}`. |
| `context`          | `clean`\|`shared` | No       | Session continuity with the previous agentic node (default: `clean`).    |
| `output_format`    | object            | No       | JSON Schema for structured output. The adapter parses and validates.     |
| `platform`         | string            | No       | Override the workflow-level platform for this node.                      |
| `platform_options` | object            | No       | Override workflow-level platform options for this node.                  |

`context: shared` continues the session from the immediately preceding agentic node. It is only
valid when `depends_on` references a single agentic predecessor — not supported in fan-in
scenarios.

---

## prompt

Runs an AI model with an inline prompt string.

```yaml
- id: summarize
  prompt: |
    Summarize the following output in one paragraph:
    ${{ needs.draft.output }}
```

| Field              | Type              | Required | Description                                     |
| ------------------ | ----------------- | -------- | ----------------------------------------------- |
| `prompt`           | string            | Yes      | Inline prompt. Supports `${{ }}` interpolation. |
| `context`          | `clean`\|`shared` | No       | Session continuity (default: `clean`).          |
| `output_format`    | object            | No       | JSON Schema for structured output.              |
| `platform`         | string            | No       | Override workflow-level platform.               |
| `platform_options` | object            | No       | Override workflow-level platform options.       |

---

## prompt_file

Runs an AI model with a prompt loaded from a file. The file supports `${{ }}` interpolation.

```yaml
- id: review
  prompt_file: prompts/code-review.md
```

| Field              | Type              | Required | Description                               |
| ------------------ | ----------------- | -------- | ----------------------------------------- |
| `prompt_file`      | string            | Yes      | Path to a prompt file. Supports `${{ }}`. |
| `context`          | `clean`\|`shared` | No       | Session continuity (default: `clean`).    |
| `output_format`    | object            | No       | JSON Schema for structured output.        |
| `platform`         | string            | No       | Override workflow-level platform.         |
| `platform_options` | object            | No       | Override workflow-level platform options. |

---

## approval

Pauses the workflow and prompts the user for approval before continuing. The engine emits an
event and waits for an external caller (CLI, TUI, or web UI) to resolve it.

```yaml
- id: approve_plan
  depends_on: [plan]
  approval:
    message: 'Review the plan before implementing. Approve to continue.'
    exit_on_no: true
```

| Field                       | Type    | Required | Description                                                            |
| --------------------------- | ------- | -------- | ---------------------------------------------------------------------- |
| `approval.message`          | string  | Yes      | Message displayed to the user. Supports `${{ }}`.                      |
| `approval.exit_on_no`       | boolean | No       | Exit the workflow immediately when the user declines (default: false). |
| `approval.enable_feedback`  | boolean | No       | Add a third option to gather user feedback.                            |
| `approval.feedback_message` | string  | No       | Prompt text when requesting feedback (default: "Other").               |

**Output** (`needs.<id>.output`):

| Field      | Type    | Description                                            |
| ---------- | ------- | ------------------------------------------------------ |
| `approved` | boolean | `true` if the user approved, `false` if they declined. |
| `feedback` | string  | User feedback string, when `enable_feedback` is true.  |

---

## exit

Immediately terminates the workflow. In-flight parallel nodes are stopped.

```yaml
- id: abort
  if: 'needs.validate.output == "fatal"'
  exit:
    reason: Validation found a fatal error.
    failure: true
```

| Field          | Type    | Required | Description                                                           |
| -------------- | ------- | -------- | --------------------------------------------------------------------- |
| `exit.reason`  | string  | No       | Human-readable reason displayed on termination.                       |
| `exit.failure` | boolean | No       | When true, the workflow exits with a failure status (default: false). |

Unlike a node failure, `exit_node` is an intentional termination: in-flight nodes are cancelled
immediately rather than allowed to run to completion.

---

## loop

Runs a list of nodes repeatedly until a condition is met or a maximum iteration count is
reached.

```yaml
- id: tdd_loop
  depends_on: [stub]
  loop:
    max_iterations: 5
    until: 'scope.nodes.test.output == "pass"'
    nodes:
      - id: implement
        agent: ts-engineer

      - id: test
        depends_on: [implement]
        bash: |
          if npm run test:unit; then
            echo "pass" > $HEIMDALL_OUTPUT
          else
            echo "fail" > $HEIMDALL_OUTPUT
          fi
```

| Field                 | Type    | Required | Description                                                                  |
| --------------------- | ------- | -------- | ---------------------------------------------------------------------------- |
| `loop.nodes`          | array   | Yes      | Node list executed each iteration.                                           |
| `loop.until`          | string  | No\*     | CEL expression; loop exits when true. Do not wrap in `${{ }}`.               |
| `loop.max_iterations` | integer | No\*     | Maximum iterations before the loop exits (success, not failure).             |
| `loop.outputs`        | object  | No       | Named CEL expressions exposed via `needs.<loop_id>.output.<key>` after exit. |

\* At least one of `until` or `max_iterations` is required.

Within the loop body and `until` / `outputs` expressions, the `scope` context is available:

| Expression                | Description                                                        |
| ------------------------- | ------------------------------------------------------------------ |
| `scope.iteration`         | Iterations completed so far. Starts at 0.                          |
| `scope.nodes.<id>.output` | Output of a child node from the most recently completed iteration. |
| `scope.needs.<id>`        | Output of a node declared in the loop's `depends_on`.              |
| `scope.outer`             | Context of the immediately enclosing loop (nested loops only).     |

Nodes inside a loop that need output from a node outside the loop must use `scope.needs.<id>`,
not `needs.<id>`.

Reaching `max_iterations` without `until` becoming true exits the loop successfully.

---

## break

Exits the innermost enclosing loop immediately. Only valid inside a `loop` node's node list.

```yaml
- id: stop_early
  depends_on: [check]
  if: 'scope.nodes.check.output == "done"'
  break: {}
```

The `break` field's value is ignored — only its presence matters.

---

## See also

- [Workflow schema](/docs/reference/workflow/) — root fields, inputs, vars, workspace
- [Expressions](/docs/reference/expressions/) — CEL syntax and context reference
- [Workflow examples](/docs/guides/workflows/) — annotated workflow patterns
