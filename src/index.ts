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

  return withErrorBoundary(bootstrapPrinter, async (): Promise<void> => {
    await program.parseAsync(process.argv);
    // With no subcommands registered yet, parseAsync dispatches to no action
    // handler, so createContext (and loadConfig) is never called via the command
    // path. This standalone call ensures flag-conflict validation still fires.
    // Remove once every command path calls createContext.
    await loadConfig(program.opts(), process.cwd());
  });
};

const main = async (): Promise<void> => {
  const exitCode = await run();
  process.exitCode = exitCode;
};

void main();
