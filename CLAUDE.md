# CLAUDE

## Overview

Heimdall is a CLI for building deterministic agentic workflows from YAML. User-defined workflows define the phases, gates, feedback loops, artifacts, and completion criteria that guide agentic work — agents provide the intelligence, Heimdall owns the structure. Each run executes in an isolated git worktree so parallel tasks don't mix changes.

## Principles

These are implementation constraints, not slogans. Apply them by default.

**YAGNI**
- No config keys, flags, abstractions, or error paths without a concrete current use case
- No speculative options, partial fake support, or stubs for hypothetical callers

**KISS**
- Prefer explicit control flow over clever meta-programming
- Straightforward branches and typed interfaces beat dynamic behavior
- Keep error paths obvious and local

**DRY + Rule of Three**
- Duplicate small, local logic when it preserves clarity
- Extract shared utilities only after the same pattern appears at least three times and has stabilized
- When extracting, preserve module boundaries and avoid hidden coupling

**SRP — Single Responsibility**
- Keep each module focused on one concern
- `command.ts` parses, `run.ts` orchestrates, `core/` contains domain logic — don't collapse these layers

**ISP — Interface Segregation**
- Don't add unrelated concerns to an existing module or interface
- When a new concern emerges, define a new interface rather than broadening an existing one

**Fail Fast, Don't Hide Failures**
- Throw `CliError` early for expected failures
- Don't catch-and-swallow or silently fall back to a default that masks the problem
- Silent failures produce confusing exit codes and hard-to-debug behavior

**Reversibility**
- Keep changes small in scope with an obvious blast radius
- For risky changes (schema changes, config format changes), identify the rollback path before starting
- Prefer sequential, mergeable steps over mega-patches

## Architecture

### Directory Structure

```text
src/
  index.ts                  # Entrypoint: argv parse + top-level error mapping
  cli/
    program.ts              # Commander setup (global flags/help/output)
    register-commands.ts    # Command module registration only
    context.ts              # Shared runtime context (cwd, config, printer, io)
    middleware/             # Cross-cutting wrappers (error boundary, signals, telemetry)
  commands/
    <command>/              # Command module (see layouts below)
  core/                     # Domain logic (no Commander/Ink dependencies)
  services/                 # Side-effect adapters (fs, process, api, etc.)
  config/                   # Schemas and config loading/merge strategy
  output/                   # Human/json output plumbing
  errors/                   # Typed app errors and error mapping
  utils/                    # Small shared helpers
test/
  unit/                     # Core logic + parsing behavior
  integration/cli/          # Built CLI invocation tests (stdout/stderr/exit code)
```

## Conventions

### Config

Shared app config is resolved once in `src/config/load-config.ts` and exposed as `ctx.config`. Commands should use `ctx.config` for shared runtime config and should not inspect config files, environment variables, or global config flag origins.

Command-specific args/options are separate from app config. Parse and validate them in `src/commands/<name>/command.ts`, then pass normalized input to `run(ctx, input)`.

**Relevant files**

| File                        | Purpose                                                          |
| --------------------------- | ---------------------------------------------------------------- |
| `src/config/schema.ts`      | Defines canonical config shape, source mappings, and Zod schemas |
| `src/config/load-config.ts` | Loads config sources and applies precedence rules                |
| `src/cli/program.ts`        | Defines global CLI flags that may feed config                    |
| `src/cli/context.ts`        | Builds `CliContext` with resolved `ctx.config`                   |

**Rules**

| Concept        | Rule                                                                                  |
| -------------- | ------------------------------------------------------------------------------------- |
| Canonical keys | Add app config fields to `configSchema` only when they are shared runtime config      |
| Source map     | Each config key is defined in `configSources` with its default and supported sources  |
| Consumers      | Commands read shared config from `ctx.config`; command-local flags become `run` input |

Precedence order, lowest to highest:

1. `configSources.<key>.defaultValue`
2. Config file values loaded by `cosmiconfig`
3. Environment variables
4. CLI flags from Commander

Only add a source to a config key when that source is intentionally supported. Do not read config-file keys, environment variables, or global config flags ad hoc in commands.

### Output

Use `output/printer.ts` for command output and log routing. Prefer semantic methods (`info`, `warn`, `debug`, etc.) over direct stream writes.

- Command code should use `Printer` for human/log output.
- `Printer` owns stdout/stderr routing for its semantic methods.
- Final command results must remain separate from logs/status output.
- Treat `--json` as final result formatting, not JSON logging.
- Do not call `console.log/error` directly in commands, core, or services.

### Errors

Expected failures should throw `CliError`.

- `src/errors/cli-error.ts` — error codes
- `src/cli/middleware/with-error-boundary.ts` — error mapping/rendering

**Rules**

- Throw `CliError` with stable `code` and `exitCode` for expected failures.
- Use `EXIT_CODE` from `src/errors/cli-error.ts`; add new codes there when needed.
- Let unknown failures bubble; do not catch-and-hide errors in commands.
- Set `process.exitCode` only in top-level code.

### Naming

- Use noun-first subcommand hierarchies ending with a verb (e.g. `heimdall repos list`, not `heimdall list-repos`).
- Prefer descriptive identifiers over abbreviations.

### Tooling Suppressions

Lint and type rules are enforced by CI. Don't suppress them to make the build pass — fix the root cause.

`// eslint-disable-next-line` and `// @ts-expect-error` are acceptable only when an external library or generated type definition is wrong, with a comment naming the specific reason. File-level disables (`/* eslint-disable */`) are never acceptable.

## Git

Heimdall uses trunk-based development.

- `main` is always deployable. All work lands on `main` via short-lived branches (aim for under 2 days).
- Long-running work uses feature flags, not long-lived branches.
- Keep commits focused and single-purpose. Do not mix formatting-only edits with behavior changes.
- One PR per logical change — don't bundle unrelated work.

**Before opening a PR**, run `npm run quality`. It covers typecheck, lint, format, and tests. CI enforces the same checks and will block on any failure.

## Commands

| Command                    | Purpose                                                  |
| -------------------------- | -------------------------------------------------------- |
| `npm run dev`              | Run source with Node native TypeScript support           |
| `npm run build`            | Bundle the CLI with `tsup`                               |
| `npm run build:sea`        | Generate Node SEA preparation blob                       |
| `npm run typecheck`        | Run TypeScript without emitting files                    |
| `npm run lint`             | Check ESLint rules                                       |
| `npm run lint:fix`         | Auto-fix ESLint issues, including import cleanup/sorting |
| `npm run format`           | Check Prettier formatting                                |
| `npm run format:fix`       | Apply Prettier formatting                                |
| `npm run test:unit`        | Run unit tests only                                      |
| `npm run test:integration` | Build then run CLI integration tests                     |
| `npm run test`             | Build then run all tests                                 |
| `npm run quality`          | Run the full pre-merge quality workflow                  |
