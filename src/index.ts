import { withErrorBoundary } from './cli/middleware/with-error-boundary.ts';
import { createProgram } from './cli/program.ts';
import { registerCommands } from './cli/register-commands.ts';
import { loadConfig } from './config/load-config.ts';
import { createPrinter } from './output/printer.ts';

const run = (): Promise<number> => {
  const program = createProgram();
  registerCommands(program);

  const bootstrapPrinter = createPrinter({
    stdout: process.stdout,
    stderr: process.stderr,
    verbose: false,
    debug: false,
    quiet: false,
  });

  // When no subcommand is given, validate global flags (e.g. --quiet + --verbose
  // conflict) and exit 0. Each registered command calls createContext, which
  // runs loadConfig, so the root action only needs to cover the no-command path.
  program.action(async () => {
    await loadConfig(program.opts(), process.cwd());
  });

  return withErrorBoundary(bootstrapPrinter, async (): Promise<void> => {
    await program.parseAsync(process.argv);
  });
};

const main = async (): Promise<void> => {
  const exitCode = await run();
  process.exitCode = exitCode;
};

void main();
