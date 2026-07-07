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

User-facing commands are not documented here yet.
