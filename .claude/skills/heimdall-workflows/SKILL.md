---
name: heimdall-workflows
description: 'Write, review, or debug a Heimdall workflow YAML file. Use this skill whenever authoring a .heimdall workflow, adding or changing nodes, writing CEL expressions or ${{ }} interpolation, wiring node dependencies, or diagnosing a workflow that fails validation. Trigger even for partial tasks like "add a bash step" or "make this node conditional".'
---

<!-- heimdall-generated: v0.1.0 — installed by `heimdall skills install`. Edits are overwritten. -->

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

Every node needs an `id` matching `^[A-Za-z_][A-Za-z0-9_]*$` — a letter or underscore
first, then letters, digits, or underscores. Ids must be **unique across the entire
workflow**, not just among siblings: a loop body node cannot reuse an id used outside
the loop. Fifteen names are reserved and rejected outright: `loop`, `worktree`,
`switch`, `each`, `outer`, `needs`, `nodes`, `prev`, `item`, `previtem`, `self`,
`scopes`, `inputs`, `vars`, `heimdall`.

All nodes also accept `name`, `depends_on`, `if`, `timeout` (ms), and `retries` — see
`references/node.yaml`.

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
      ${{ self.needs.gather.output }}
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

**The namespace is closed at five roots.** Every expression site binds exactly these,
and nothing else — a bare node id does not resolve, and neither does a bare `needs`,
`nodes`, or `iteration`:

| Root       | Meaning                                                |
| ---------- | ------------------------------------------------------ |
| `inputs`   | Resolved workflow inputs, after defaults               |
| `vars`     | Static workflow variables                              |
| `heimdall` | Run-wide values: `session_dir`, `run_cwd`              |
| `self`     | What this node knows about itself right now            |
| `scopes`   | The enclosing loops, keyed by loop node id (see Loops) |

### `self` — and why it changes

`self` is phase-dependent, because the phase decides what has happened by then.

| Site                                              | `self` binds                   |
| ------------------------------------------------- | ------------------------------ |
| A node's own `if`, and `${{ }}` in its own fields | `needs`                        |
| A loop's own `while` / `until` / `outputs`        | `needs`, `nodes`, `iterations` |

`self.needs.<id>` is the result of a node listed in **this** node's `depends_on`. It is
narrowed to declared edges: a node that ran but was not declared is absent, and so is a
declared dependency that got skipped. Reading a node you did not declare is an error,
not an empty value.

`self.nodes` and `self.iterations` exist **only at a loop checkpoint**. A node's `if`
cannot read `self.nodes` — at that point the node has produced nothing.

`heimdall.session_dir` is a per-run temp directory for passing files between nodes;
`heimdall.run_cwd` is the directory the run started in, constant even inside a worktree.

Guard anything that may not have run with `has()`:

```yaml
if: has(self.needs.review.output) && self.needs.review.output.status == "failed"
```

## Node results

Each node type exposes a fixed result shape under `self.needs.<id>` — see
`references/results/`.

**bash** → `self.needs.<id>.output`. The engine injects `$HEIMDALL_OUTPUT`, a path to a
temp file. **Only what you write to that file becomes the output** — incidental stdout
from other commands does not contaminate it. Write nothing and the output is empty.

```yaml
- id: changed_files
  bash: git diff --name-only ${{ vars.base_branch }} > "$HEIMDALL_OUTPUT"
```

With `output_format: json`, the file contents are parsed and fields become accessible
as `self.needs.<id>.output.<field>`. Invalid JSON fails the node immediately.

**agentic** → `self.needs.<id>.output`, a string. Define `output_format` (a JSON Schema
object) to get a structured object instead, addressable field by field:

```yaml
- id: triage
  prompt: Classify this issue. ${{ self.needs.read_issue.output }}
  output_format:
    type: object
    properties:
      severity: { type: string, enum: [low, high] }
    required: [severity]

- id: page_oncall
  depends_on: [triage]
  if: self.needs.triage.output.severity == "high"
  bash: ./notify.sh
```

**approval** → `self.needs.<id>.output.approved` (boolean) and, with
`enable_feedback: true`, `self.needs.<id>.output.feedback`.

**loop** → `self.needs.<id>.iterations` and `self.needs.<id>.output.<key>` for each key
declared in the loop's `outputs` map.

## Loops

A loop repeats its `nodes` body. It needs at least one of `until`, `while`, or
`max_iterations`; `until` and `while` are mutually exclusive.

- `until` is a **post**-condition — the body always runs at least once.
- `while` is a **pre**-condition — the body may run zero times.
- `max_iterations` caps the loop regardless of the other two. Set it on any loop whose
  condition depends on agent output; a model that never reports success would otherwise
  loop forever.

A loop is read from two different vantage points, and they bind different names.

**From inside the body**, the enclosing loop is `scopes.<loop_id>` — keyed by the loop
node's own id:

| Expression                    | Meaning                                                      |
| ----------------------------- | ------------------------------------------------------------ |
| `scopes.<loop_id>.index`      | Zero-based index of the running execution; `0` on the first  |
| `scopes.<loop_id>.needs.<id>` | Outputs of the _loop node's_ `depends_on`                    |
| `scopes.<loop_id>.prev.<id>`  | Body results from the previous execution; empty on the first |

`scopes` is **flat, not chained** — every enclosing loop is addressed by its own id at
any depth, so `scopes.outer_loop.index` works from a nested body without stepping
through anything. Wrapping an existing node list in a new enclosing loop therefore
leaves every reference in it valid.

**From the loop's own checkpoints** (`while`, `until`, `outputs`), the loop reads
itself through `self`:

| Expression        | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `self.iterations` | Body executions terminated so far; `0` at the first `while` |
| `self.nodes.<id>` | Results of the latest body execution only                   |
| `self.needs.<id>` | Outputs of this loop node's own `depends_on`                |

The two vantage points do not overlap. A body node has an `index`, not `iterations`; a
checkpoint has `iterations`, not an `index`. **A loop never appears in its own `scopes`
map** — `scopes.<own_id>` fails inside its own `until` or `outputs`, though an enclosing
loop's `scopes.<outer_id>` is bound there.

**Body nodes cannot `depends_on` nodes outside the loop.** Declare the dependency on the
loop node itself and read it through `scopes.<loop_id>.needs.<id>`.

```yaml
- id: fix_until_green
  depends_on: [plan]
  loop:
    max_iterations: 5
    until: self.nodes.tests.output.passed
    nodes:
      - id: implement
        prompt: |
          Plan: ${{ scopes.fix_until_green.needs.plan.output }}
          Attempt ${{ scopes.fix_until_green.index + 1 }}.
      - id: tests
        depends_on: [implement]
        bash: |
          if npm test > /dev/null 2>&1; then
            echo '{"passed":true}' > "$HEIMDALL_OUTPUT"
          else
            echo '{"passed":false}' > "$HEIMDALL_OUTPUT"
          fi
        output_format: json
    outputs:
      attempts: self.iterations
      passed: 'has(self.nodes.tests) ? self.nodes.tests.output.passed : false'
```

`outputs` values are bare CEL evaluated at the loop's final checkpoint. Guard with
`has()` — on an early `break`, `self.nodes` holds only what completed.

**Quote any bare-CEL value containing a ternary.** YAML reads the `:` in
`a ? b : c` as a mapping separator, so an unquoted ternary is a parse error before
Heimdall ever sees it. Single-quote the whole expression, as `passed` does above.

Use a `break` node with an `if` guard to exit from inside an iteration. A `break` whose
`if` is false is simply skipped and does not cascade.

## Control flow

`exit` ends the whole workflow immediately, stopping in-flight parallel nodes. Set
`failure: true` for a non-zero exit status.

`approval` pauses for the user. With `exit_on_no: true` a decline ends the run; with the
default `false` the workflow continues and downstream nodes route on
`self.needs.<id>.output.approved`.

## Agentic node guidance

- **`context: clean` (default) starts a fresh session.** `context: shared` continues from
  the immediately preceding agentic node, and is only valid with a single agentic
  predecessor — it will not work in fan-in. Prefer passing data explicitly through node
  outputs or files in `heimdall.session_dir`; shared context hides the data flow.
- Set `disable_tool_search: true` in `platform_options` so only explicitly configured
  tools are available. Autodiscovery makes runs non-deterministic, which is the thing
  Heimdall exists to prevent.
- Use `output_format` whenever a downstream node branches on the result. Branching on
  substrings of free-form prose is fragile.
- `max_budget_usd` caps spend per node. Worth setting on loop bodies.

See `references/claude_options.yaml` for the full option list.

## Writing checklist

1. Is every node `id` a valid identifier, unique workflow-wide, and not a reserved name?
2. Does every node that reads `self.needs.<id>` declare that id in `depends_on`?
3. Does every reference resolve under one of the five roots — `inputs`, `vars`,
   `heimdall`, `self`, `scopes`? (No bare `needs`, `scope`, `sessionDir`, or node id.)
4. Do loop body nodes use `scopes.<loop_id>.index`, and loop checkpoints
   `self.iterations` / `self.nodes` — not the other way round?
5. Are `if` / `until` / `while` / `outputs` written as **bare CEL**, with no `${{ }}`?
6. Do bash nodes write to `$HEIMDALL_OUTPUT` rather than relying on stdout?
7. Does every loop have a `max_iterations` bound?
8. Does any node branching on agent output use `output_format` instead of prose matching?
9. Are optional or conditional references guarded with `has()`?
