# Heimdall

Heimdall is a CLI for building deterministic agentic workflows from YAML.

AI agents are powerful, but the process around them is often implicit. Planning gets skipped, validation drifts, feedback is handled inconsistently, and handoffs miss team standards.

Heimdall makes that process explicit. User-defined workflows describe the phases, gates, feedback loops, artifacts, and completion criteria that guide agentic work. Agents provide the intelligence; Heimdall owns the structure.

Each run executes in an isolated git worktree, so teams can run fixes and implementation tasks in parallel without mixing changes.

## Why Heimdall?

- **Deterministic structure** - YAML workflows define phases, gates, and artifacts.
- **First-class feedback loops** - Review, validation, correction, and retry paths are part of the workflow model.
- **Isolated execution** - Runs use separate git worktrees so parallel fixes can proceed without conflicts.
- **PR-ready workflows** - Teams can model paths from ticket or issue intake through implementation, validation, review, and PR creation.
- **Complex process modeling** - Heimdall is built for workflows with branching, iteration, and explicit handoffs, not just linear agent prompts.

## Usage

### `heimdall run <file>`

Executes a workflow YAML file.

```
heimdall run <file> [--input key=value]...
```

**Arguments**

| Argument | Description |
|---|---|
| `<file>` | Path to a workflow YAML file (relative or absolute) |

**Options**

| Option | Description |
|---|---|
| `-i, --input <key=value>` | Pass a runtime input to the workflow. Repeatable. |
| `--json` | Suppress progress output; write a single JSON result to stdout |
| `--quiet` | Suppress progress output; still prints final success/failure |
| `--verbose` | Show additional detail for each node |

**Examples**

Run a workflow with no inputs:
```sh
heimdall run deploy.yaml
```

Pass runtime inputs (repeatable):
```sh
heimdall run deploy.yaml --input env=production --input region=us-east-1
```

Machine-readable output:
```sh
heimdall run deploy.yaml --json
# stdout: {"success":true}
```

**Exit codes**

| Code | Meaning |
|---|---|
| `0` | Workflow completed successfully |
| `1` | Workflow ran but failed, or an unexpected error occurred |
| `2` | Bad invocation — missing file, unknown input key, missing required input, or invalid YAML |
| `3` | Configuration error — unreadable file or invalid workflow graph |

**Workflow YAML**

A minimal workflow requires `name` and at least one node:

```yaml
name: hello
nodes:
  - id: greet
    bash: echo "Hello, world!"
```

Workflows can declare typed inputs with optional defaults:

```yaml
name: deploy
inputs:
  env:
    type: string
    description: Target environment
  region:
    type: string
    default: us-east-1
nodes:
  - id: run_deploy
    bash: ./scripts/deploy.sh ${{ inputs.env }} ${{ inputs.region }}
```

Nodes can depend on each other and use the output of prior nodes:

```yaml
name: pipeline
nodes:
  - id: build
    bash: |
      npm run build
      echo -n "dist/" > "$HEIMDALL_OUTPUT"
  - id: test
    depends_on: [build]
    bash: echo "Testing output at ${{ needs.build.output }}"
```

Approval gates pause execution and prompt the user before continuing:

```yaml
name: guarded-deploy
nodes:
  - id: confirm
    approval:
      message: Deploy to production?
      exit_on_no: true
  - id: deploy
    depends_on: [confirm]
    bash: ./deploy.sh
```
