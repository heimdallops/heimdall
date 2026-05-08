---
name: heimdall-cli-command
description: >
  Create, update, test, or review a Heimdall CLI command. Use this skill whenever
  implementing a new command, modifying an existing command, writing or fixing tests
  for a command, or reviewing a command for convention adherence. Trigger even for
  partial tasks like "add a flag to X" or "review the run.ts for Y".
---

# Heimdall CLI Command

## Structure

Every command follows one of two layouts:

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

## Creating a new command

1. Use a noun-first subcommand hierarchy ending with a verb (e.g. `heimdall repos list`, not `heimdall list-repos`).
2. Create `src/commands/<name>/command.ts` — Commander wiring and Zod validation.
3. Export `buildCommand(program): void` from `command.ts`.
4. Define args/options, descriptions, examples, and common workflows in `command.ts`.
5. Build `CliContext` inside the action handler using `program.opts()` so global flags are available.
6. Validate all args/options with Zod before calling any runtime logic.
7. Create `src/commands/<name>/run.ts` — orchestration only; call `run(ctx, input)` explicitly.
8. Put reusable domain logic in `src/core/`; put side-effect adapters in `src/services/` only when they centralize real behavior.
9. Register the command in `src/cli/register-commands.ts`.
10. Write tests (see **Testing** below).
11. Run `npm run quality` before finishing.

**TUI commands** additionally need `src/commands/<name>/tui/app.tsx` and must reject `--json` or provide an explicit non-TUI fallback.

## Updating an existing command

1. Read the existing `command.ts` and `run.ts` to understand current behavior before changing anything.
2. Make changes in `command.ts` for flag/arg changes; keep orchestration changes in `run.ts`.
3. Update or add Zod schemas to cover any new inputs.
4. Update tests to cover the new behavior (see **Testing** below).
5. Run `npm run quality` before finishing.

## Testing a command

- **Unit tests** go in `test/unit/` and cover pure logic and arg parsing.
- **Integration tests** go in `test/integration/cli/` and invoke the built CLI with `execa`.
- In integration tests, assert exit code, stdout, and stderr explicitly for every case.
- Do not use snapshots for output that contains ANSI escape sequences or other unstable content.
- Run `npm run test:unit` or `npm run test:integration` to verify before finishing.

## Reviewing a command

Check for these issues:

- **Structure**: `command.ts` handles wiring/validation only; `run.ts` handles orchestration only; domain logic lives in `src/core/`.
- **Export**: `command.ts` exports `buildCommand(program): void` — nothing else.
- **Validation**: all args/options validated with Zod before any runtime logic; errors are actionable.
- **Output routing**: final results go to stdout; logs, warnings, progress, and errors go to stderr via `Printer`.
- **No `console.log/error`** in commands, core, or services — use `ctx.printer` methods.
- **No `process.exit()`** in commands, core, or services.
- **Error handling**: expected failures throw `CliError` with a stable `code` and `exitCode`; unknown errors bubble up.
- **`--json` support**: either implemented as final-result formatting, or explicitly rejected with a clear error.
- **Config/env**: commands read from `ctx.config` only; no direct `process.env` or config file reads.
- **Telemetry**: no tracing or telemetry in commands — middleware only (`src/cli/middleware/`).
- **Tests**: unit and integration tests exist and assert exit code, stdout, and stderr.

## Output rules

- Write final command output to stdout.
- Write logs, progress, diagnostics, warnings, and errors to stderr.
- Treat `--json` as final result formatting, not JSON logging.

## Avoid

- Do not add placeholder commands or placeholder core files.
- Do not call `process.exit()` inside commands, core, or services.
- Do not read env/config files directly in commands; use resolved `ctx.config`.
- Do not add generic wrappers around dependencies without concrete behavior to centralize.
- Do not add telemetry or tracing in commands; keep it in `src/cli/middleware/`.
