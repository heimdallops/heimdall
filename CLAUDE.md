# CLAUDE

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

### Command Structure

| Rule            | Expectation                                                                      |
| --------------- | -------------------------------------------------------------------------------- |
| Export          | `command.ts` exports `buildCommand(program): void`                               |
| Separation      | Parse/validate in `command.ts`; orchestrate in `run.ts`; domain logic in `core/` |
| Context         | Build one `CliContext`; pass `run(ctx, input)` explicitly                        |
| Validation      | Use `zod` for args/options/config/env; fail fast with actionable errors          |
| Output + errors | Use `output/printer.ts`; keep stdout/stderr separate; throw typed `CliError`     |
| TUI mode        | Ink commands reject `--json` or provide explicit non-TUI fallback                |

#### Layouts

**Normal command**

```text
src/commands/<name>/
  command.ts   # commander wiring + zod parse
  run.ts       # orchestration only
```

**TUI command**

```text
src/commands/<name>/
  command.ts         # commander wiring + mode checks (e.g. --json)
  run.ts             # orchestration + Ink render call
  tui/
    app.tsx          # Ink app root
    components/      # optional TUI-only components
```

## Config

Shared app config is resolved once in `src/config/load-config.ts` and exposed as `ctx.config`. Commands should use `ctx.config` for shared runtime config and should not inspect config files, environment variables, or global config flag origins.

Command-specific args/options are separate from app config. Parse and validate them in `src/commands/<name>/command.ts`, then pass normalized input to `run(ctx, input)`.

### Relevant Files

| File                        | Purpose                                                          |
| --------------------------- | ---------------------------------------------------------------- |
| `src/config/schema.ts`      | Defines canonical config shape, source mappings, and Zod schemas |
| `src/config/load-config.ts` | Loads config sources and applies precedence rules                |
| `src/cli/program.ts`        | Defines global CLI flags that may feed config                    |
| `src/cli/context.ts`        | Builds `CliContext` with resolved `ctx.config`                   |

### Source Rules

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

## Output

Use `output/printer.ts` for command output and log routing. Prefer semantic methods (`info`, `warn`, `debug`, etc.) over direct stream writes.

**Rules**

- Command code should use `Printer` for human/log output.
- `Printer` owns stdout/stderr routing for its semantic methods.
- Final command results must remain separate from logs/status output.
- Treat `--json` as final result formatting, not JSON logging.
- Do not call `console.log/error` directly in commands, core, or services.

## Errors

Expected failures should throw `CliError`.

**Important References**

- `src/errors/cli-error.ts` - error codes
- `src/cli/middleware/with-error-boundary.ts` - error mapping/rendering

**Rules**

- Throw `CliError` with stable `code` and `exitCode` for expected failures.
- Use `EXIT_CODE` from `src/errors/cli-error.ts`; add new codes there when needed.
- Let unknown failures bubble; do not catch-and-hide errors in commands.
- Set `process.exitCode` only in top-level code.

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
