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

## Installation

Heimdall ships as a self-contained binary for macOS (Apple silicon and Intel), Linux (x64 and arm64), and Windows (x64) — no runtime dependencies required.

### Homebrew (macOS)

```sh
brew tap heimdallops/heimdall
brew install heimdall
```

Or install in one step:

```sh
brew install heimdallops/heimdall/heimdall
```

### Shell installer (Linux and macOS)

Detects your platform, downloads the matching archive from the latest release, verifies its checksum, and installs to `/usr/local/bin`:

```sh
curl -fsSL https://github.com/heimdallops/heimdall/releases/latest/download/install.sh | bash
```

Pin a version or change the install directory with environment variables:

```sh
curl -fsSL https://github.com/heimdallops/heimdall/releases/latest/download/install.sh | VERSION=0.1.0 INSTALL_DIR=~/.local/bin bash
```

### Manual download (including Windows)

1. Download the archive for your platform from the [releases page](https://github.com/heimdallops/heimdall/releases) — `heimdall-<os>-<arch>.tar.gz` (`heimdall-windows-x64.zip` on Windows).
2. Extract it. Each archive contains a single `heimdall` binary (`heimdall.exe` on Windows).
3. Move the binary somewhere on your `PATH`.

Every release includes a `checksums.txt` if you want to verify the download.

### Verify the installation

```sh
heimdall --version
```

## Usage

### `heimdall run <file>`

Executes a workflow YAML file.

```
heimdall run <file> [--input key=value]...
```

**Arguments**

| Argument | Description                                         |
| -------- | --------------------------------------------------- |
| `<file>` | Path to a workflow YAML file (relative or absolute) |

**Options**

| Option                    | Description                                                    |
| ------------------------- | -------------------------------------------------------------- |
| `-i, --input <key=value>` | Pass a runtime input to the workflow. Repeatable.              |
| `--approve`               | Automatically approve every approval gate without prompting    |
| `--json`                  | Suppress progress output; write a single JSON result to stdout |
| `--quiet`                 | Suppress progress output; still prints final success/failure   |
| `--verbose`               | Show additional detail for each node                           |

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
# {"success":true}
```

**Exit codes**

| Code | Meaning                                                                       |
| ---- | ----------------------------------------------------------------------------- |
| `0`  | Workflow completed successfully                                               |
| `1`  | An unexpected error occurred                                                  |
| `2`  | Bad invocation — missing file, unknown/invalid/missing input, or invalid YAML |
| `3`  | Reserved — application configuration error                                    |
| `4`  | Reserved — authentication error                                               |
| `5`  | Workflow configuration error — unreadable file or invalid workflow graph      |
| `6`  | Workflow ran but failed                                                       |

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

### `heimdall skills install <platform>`

Installs Heimdall's workflow-authoring skill into a coding agent, so it can write valid
workflow YAML without being handed the docs. The skill ships with the workflow JSON
schemas as reference material.

```bash
heimdall skills install claude              # into ./.claude/skills
heimdall skills install codex               # into ./.agents/skills
heimdall skills install claude --scope user # into ~/.claude/skills
heimdall skills install claude --dry-run    # print the files, write nothing
```

The platform is required — nothing is installed into an agent you did not name.

| Platform   | Project scope      | User scope         |
| ---------- | ------------------ | ------------------ |
| `claude`   | `./.claude/skills` | `~/.claude/skills` |
| `opencode` | `./.agents/skills` | `~/.agents/skills` |
| `codex`    | `./.agents/skills` | `~/.agents/skills` |

The content is identical for all three — [Agent Skills](https://agentskills.io) is one open
format, and only the directory differs. `opencode` and `codex` share `.agents/skills`, the
standard's tool-neutral location that both agents read. OpenCode also scans `.claude/skills`,
so a `claude` install is already visible to it.

Each platform owns its own root: installing or uninstalling for one never touches another.

| Option        | Description                            |
| ------------- | -------------------------------------- |
| `-s, --scope` | `project` (default) or `user`          |
| `-f, --force` | Overwrite files Heimdall did not write |
| `--dry-run`   | Print the files that would be written  |
| `--json`      | Print the result as JSON               |

Installed files are stamped with a marker. A reinstall replaces its own previous output,
but refuses to overwrite a file you edited by hand unless you pass `--force`.

A reinstall sweeps before it writes, so upgrading converges on exactly what the current
version ships — including removing a whole skill this version no longer has, which your
agent would otherwise go on loading. Removals are listed, and a file without the marker is
never removed: if you added it to the skill directory, it stays, and so does the directory.

### `heimdall skills uninstall <platform>`

Removes every skill Heimdall installed, **including skills this version no longer ships** —
one renamed, retired, or written by an older CLI. Installed skills are found by the marker
on disk rather than by what this build knows about, which is what makes that possible.

```bash
heimdall skills uninstall claude            # confirms first
heimdall skills uninstall claude --yes      # no prompt
heimdall skills uninstall claude --dry-run  # show what would go
```

| Option        | Description                                        |
| ------------- | -------------------------------------------------- |
| `-s, --scope` | `project` (default) or `user`                      |
| `-y, --yes`   | Skip the confirmation prompt                       |
| `-f, --force` | Also remove a directory with no generated SKILL.md |
| `--dry-run`   | Print what would be removed                        |
| `--json`      | Print the result as JSON                           |

Files Heimdall did not write are always kept, and keep their directory with them. Without a
terminal to prompt on, the command refuses unless you pass `--yes`.

### `heimdall skills list <platform>`

Shows what is installed, including skills this version no longer ships, with the CLI
version that wrote each one.

```bash
heimdall skills list claude
heimdall skills list claude --scope user
heimdall skills list claude --json
```

It reads only — it is the same discovery `uninstall` uses, so what it lists is exactly what
`uninstall` would act on.
