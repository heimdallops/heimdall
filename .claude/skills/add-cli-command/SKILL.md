---
name: heimdall-cli-command
description: Add or update a Heimdall CLI command using the project command architecture.
---

# Add CLI Command

Use this skill when implementing a concrete CLI command.

## Checklist

1. Create `src/commands/<name>/command.ts`.
2. Export `buildCommand(program): void` from `command.ts`.
3. Define Commander args/options, descriptions, examples, and common workflows in `command.ts`.
4. Create `CliContext` inside the Commander action after parsing, using `program.opts()` so global flags are available.
5. Validate args/options with `zod` before calling runtime logic.
6. Create `src/commands/<name>/run.ts` for orchestration.
7. Pass `run(ctx, input)` explicitly; do not use global context.
8. Put domain logic in `src/core/` when it is not command-specific orchestration.
9. Put side-effect adapters in `src/services/` only when they centralize real behavior.
10. Register the command in `src/cli/register-commands.ts`.
11. Add unit tests for parsing/core behavior under `test/unit/`.
12. Add integration tests under `test/integration/cli/` that invoke the built CLI with `execa`.
13. Run `npm run quality` before finishing.

## Output Rules

- Write final command output to stdout.
- Write logs, progress, diagnostics, warnings, and errors to stderr.
- Treat `--json` as final result formatting, not JSON logging.
- TUI commands must reject `--json` unless they provide a non-TUI fallback.

## Avoid

- Do not add placeholder commands or placeholder core files.
- Do not call `process.exit()` inside commands, core, or services.
- Do not read env/config files directly in commands; use resolved `ctx.config`.
- Do not add generic wrappers around dependencies without concrete behavior to centralize.
