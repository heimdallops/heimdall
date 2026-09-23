# Heimdall Workflows

Heimdall runs deterministic agentic workflows defined in YAML. A workflow is a named
graph of nodes executed in dependency order. Agents supply the intelligence; the
workflow owns the structure.

The `references/` directory beside this file holds the authoritative JSON Schemas.
**Read the relevant schema before writing a node** — this document teaches the model,
the schemas define what is valid.

## Workflow anatomy

```yaml
name: fix-issue # required
version: '1'
description: Fix a reported issue and open a PR.
platform: claude # default platform for agentic nodes
platform_options: # default options for agentic nodes
  model: claude-sonnet-5
  disable_tool_search: true
inputs: # supplied at run time
  issue_number:
    type: integer
    description: The GitHub issue to fix.
vars: # static, available everywhere
  base_branch: main
workspace:
  worktree: true # run in an isolated git worktree (default true)
nodes: # required, at least one
  - id: read_issue
    bash: gh issue view ${{ inputs.issue_number }} --json title,body > "$HEIMDALL_OUTPUT"
    output_format: json
```

Only `name` and `nodes` are required. See `references/workflow.yaml`.

## Nodes

Every node needs a unique `id` matching `^[a-zA-Z0-9_]+$`. All nodes also accept
`name`, `depends_on`, `if`, `timeout` (ms), and `retries` — see `references/node.yaml`.

A node's _type_ is inferred from which type-specific key is present. There is no
`type:` field. Exactly one of these keys determines the node type:

| Key           | Node type   | Purpose                                      |
| ------------- | ----------- | -------------------------------------------- |
| `bash`        | bash        | Run a shell script                           |
| `agent`       | agent       | Run a named/file-based agent definition      |
| `prompt`      | prompt      | Run a model with an inline prompt            |
| `prompt_file` | prompt file | Run a model with a prompt loaded from a file |
| `approval`    | approval    | Pause and ask the user                       |
| `loop`        | loop        | Repeat a body of nodes                       |
| `exit`        | exit        | End the workflow immediately                 |
| `break`       | break       | Exit the innermost enclosing loop            |

`agent`, `prompt`, and `prompt_file` are the _agentic_ nodes. They additionally accept
`platform`, `platform_options`, `context`, and `output_format`
(`references/agentic_node.yaml`).

## Dependencies and ordering

`depends_on` lists node ids that must complete first. Nodes with no unmet dependencies
run in parallel, so **order in the `nodes` list means nothing** — only `depends_on`
establishes ordering. If a node reads another node's output, it must declare the
dependency.

```yaml
nodes:
  - id: gather
    bash: git log --oneline -20 > "$HEIMDALL_OUTPUT"

  - id: summarize
    depends_on: [gather]
    prompt: |
      Summarize these commits:
      ${{ needs.gather.output }}
```

The graph must be acyclic. A node whose dependency was skipped is itself skipped, and
that cascades — except for `break` and `exit`, which produce no output and so do not
propagate a skip to their dependents.

## Expressions

Heimdall uses CEL in two forms, and the difference matters:

- **`${{ expression }}` interpolation** — inside string fields (`bash`, `prompt`,
  `instructions`, `agent`, `prompt_file`, `env` values, `approval.message`). The result
  is substituted into the string.
- **Bare CEL** — in `if`, `loop.until`, `loop.while`, and `loop.outputs` values.
  **Do not wrap these in `${{ }}`.** An `if` expression must evaluate to a boolean.

Available in expression context:

| Name         | Meaning                                                         |
| ------------ | --------------------------------------------------------------- |
| `inputs.<k>` | Resolved workflow inputs, after defaults                        |
| `vars.<k>`   | Static workflow variables                                       |
| `needs.<id>` | Result of a node this node `depends_on`                         |
| `sessionDir` | Absolute path to a per-run temp directory; use it to pass files |
| `cwd`        | Working directory of the run                                    |
| `scope`      | Loop context — only inside a loop body (see Loops)              |

`needs` only contains nodes listed in this node's `depends_on`. Referencing a node you
did not declare is an error, not an empty value.

Guard anything that may not have run with `has()`:

```yaml
if: has(needs.review.output) && needs.review.output.status == "failed"
```

## Node results

Each node type exposes a fixed result shape under `needs.<id>` — see
`references/results/`.

**bash** → `needs.<id>.output`. The engine injects `$HEIMDALL_OUTPUT`, a path to a temp
file. **Only what you write to that file becomes the output** — incidental stdout from
other commands does not contaminate it. Write nothing and the output is empty.

```yaml
- id: changed_files
  bash: git diff --name-only ${{ vars.base_branch }} > "$HEIMDALL_OUTPUT"
```

With `output_format: json`, the file contents are parsed and fields become accessible
as `needs.<id>.output.<field>`. Invalid JSON fails the node immediately.

**agentic** → `needs.<id>.output`, a string. Define `output_format` (a JSON Schema
object) to get a structured object instead, addressable field by field:

```yaml
- id: triage
  prompt: Classify this issue. ${{ needs.read_issue.output }}
  output_format:
    type: object
    properties:
      severity: { type: string, enum: [low, high] }
    required: [severity]

- id: page_oncall
  depends_on: [triage]
  if: needs.triage.output.severity == "high"
  bash: ./notify.sh
```

**approval** → `needs.<id>.output.approved` (boolean) and, with `enable_feedback: true`,
`needs.<id>.output.feedback`.

**loop** → `needs.<id>.total_iterations` and `needs.<id>.output.<key>` for each key
declared in the loop's `outputs` map.

## Loops

A loop repeats its `nodes` body. It needs at least one of `until`, `while`, or
`max_iterations`; `until` and `while` are mutually exclusive.

- `until` is a **post**-condition — the body always runs at least once.
- `while` is a **pre**-condition — the body may run zero times.
- `max_iterations` caps the loop regardless of the other two. Set it on any loop whose
  condition depends on agent output; a model that never reports success would otherwise
  loop forever.

Inside the body, `scope` replaces direct outside access:

| Expression         | Meaning                                         |
| ------------------ | ----------------------------------------------- |
| `scope.iteration`  | Completed iterations; `0` during the first pass |
| `scope.nodes.<id>` | Results of the loop's own body nodes            |
| `scope.needs.<id>` | Outputs of the _loop node's_ `depends_on`       |
| `scope.outer`      | The enclosing loop, for nested loops; chains    |

**Body nodes cannot `depends_on` nodes outside the loop.** Declare the dependency on the
loop node itself and read it through `scope.needs.<id>`.

```yaml
- id: fix_until_green
  depends_on: [plan]
  loop:
    max_iterations: 5
    until: scope.nodes.tests.output.passed
    nodes:
      - id: implement
        prompt: |
          Plan: ${{ scope.needs.plan.output }}
          Attempt ${{ scope.iteration }}.
      - id: tests
        depends_on: [implement]
        bash: npm test > "$HEIMDALL_OUTPUT" 2>&1 || echo '{"passed":false}' > "$HEIMDALL_OUTPUT"
        output_format: json
    outputs:
      attempts: scope.iteration
      passed: has(scope.nodes.tests) ? scope.nodes.tests.output.passed : false
```

`outputs` values are bare CEL evaluated in the final iteration's context. Guard with
`has()` — on an early `break`, `scope.nodes` holds only what completed.

Use a `break` node with an `if` guard to exit from inside an iteration. A `break` whose
`if` is false is simply skipped and does not cascade.

## Control flow

`exit` ends the whole workflow immediately, stopping in-flight parallel nodes. Set
`failure: true` for a non-zero exit status.

`approval` pauses for the user. With `exit_on_no: true` a decline ends the run; with the
default `false` the workflow continues and downstream nodes route on
`needs.<id>.output.approved`.

## Agentic node guidance

- **`context: clean` (default) starts a fresh session.** `context: shared` continues from
  the immediately preceding agentic node, and is only valid with a single agentic
  predecessor — it will not work in fan-in. Prefer passing data explicitly through node
  outputs or files in `sessionDir`; shared context hides the data flow.
- Set `disable_tool_search: true` in `platform_options` so only explicitly configured
  tools are available. Autodiscovery makes runs non-deterministic, which is the thing
  Heimdall exists to prevent.
- Use `output_format` whenever a downstream node branches on the result. Branching on
  substrings of free-form prose is fragile.
- `max_budget_usd` caps spend per node. Worth setting on loop bodies.

See `references/claude_options.yaml` for the full option list.

## Writing checklist

1. Does every node have a unique `id` matching `^[a-zA-Z0-9_]+$`?
2. Does every node that reads `needs.<id>` declare that id in `depends_on`?
3. Are `if` / `until` / `while` / `outputs` written as **bare CEL**, with no `${{ }}`?
4. Do bash nodes write to `$HEIMDALL_OUTPUT` rather than relying on stdout?
5. Does every loop have a `max_iterations` bound?
6. Does any node branching on agent output use `output_format` instead of prose matching?
7. Are optional or conditional references guarded with `has()`?
