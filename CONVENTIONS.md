# Project Conventions

## Runtime and Toolchain

- Target Node.js v24+.
- Use Node native TypeScript execution for development scripts (`node --experimental-strip-types`).
- Use strict TypeScript compiler settings.

## Architecture

- Keep command wiring in `src/cli` and behavior in `src/commands/**/run.ts`.
- Keep domain logic in `src/core` and service adapters in `src/services`.
- Keep command action handlers thin: parse/validate input then call `run(ctx, input)`.
- Build one shared `CliContext` per process; pass it explicitly.

## Command Contract

- Every command module exports `buildCommand(program)` from `command.ts`.
- Perform parsing and validation in `command.ts`.
- Keep business rules out of Commander and Ink layers.
- Every command should provide description, examples, and common workflows in help text.

## Validation and Errors

- Validate args, flags, config files, and environment variables with Zod.
- Throw typed `CliError` with stable `code` and `exitCode` for expected failures.
- Map unknown errors once in global middleware and render safe error output.
- Do not call `process.exit()` outside `src/index.ts`.

## Output and UX

- Reserve stdout for final command output only.
- Send errors, warnings, progress, diagnostics, and verbose/debug logs to stderr.
- Use `output/printer.ts` for human/log output and stream routing.
- Let command code own final result formatting, including `--json` output.
- TUI commands must reject `--json` or implement explicit fallback behavior.

## Naming and File Size

- Use verb-first command names (`init`, `doctor`, `dashboard`, `deploy`, etc.).
- Prefer descriptive identifiers over abbreviations.

## Observability and Debugging

- Support `--verbose` and `--debug` global flags.
- Keep telemetry and tracing in middleware only.
- Keep log format stable and deterministic for testability.

## Testing

- Put unit tests under `test/unit` for pure logic and parsing.
- Put integration tests under `test/integration` and invoke the built CLI with `execa`.
- Assert exit code, stdout, and stderr explicitly.
- Avoid snapshots for unstable output such as ANSI color sequences.

## Linting and Formatting

- Use ESLint + TypeScript rules to enforce safety and consistency.
- Use Prettier for formatting; do not hand-format around Prettier output.
- Run `npm run quality` before merging.

## Available Commands

| Command                    | Purpose                                        |
| -------------------------- | ---------------------------------------------- |
| `npm run dev`              | Run source with Node native TypeScript support |
| `npm run build`            | Bundle the CLI                                 |
| `npm run build:sea`        | Generate Node SEA preparation blob             |
| `npm run typecheck`        | Run TypeScript checks                          |
| `npm run lint`             | Check ESLint rules                             |
| `npm run lint:fix`         | Auto-fix ESLint issues                         |
| `npm run format`           | Check Prettier formatting                      |
| `npm run format:fix`       | Apply Prettier formatting                      |
| `npm run test:unit`        | Run unit tests                                 |
| `npm run test:integration` | Build then run CLI integration tests           |
| `npm run test`             | Build then run all tests                       |
| `npm run quality`          | Run the full pre-merge quality workflow        |

## Git and Change Scope

- Keep commits focused and single-purpose.
- Do not mix formatting-only edits with behavior changes when avoidable.
- Prefer additive scaffolding and avoid speculative implementation.
