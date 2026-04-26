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

User-facing commands and installation instructions are not documented here yet.
