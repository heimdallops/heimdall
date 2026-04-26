import { withErrorBoundary } from './cli/middleware/with-error-boundary.ts';
import { createProgram } from './cli/program.ts';
import { registerCommands } from './cli/register-commands.ts';
import { createPrinter } from './output/printer.ts';

const run = async (): Promise<number> => {
  const program = createProgram();
  registerCommands(program);

  const bootstrapPrinter = createPrinter({
    stdout: process.stdout,
    stderr: process.stderr,
    verbose: false,
    debug: false,
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
