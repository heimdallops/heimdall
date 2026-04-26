import { createContext } from './cli/context.ts';
import { withErrorBoundary } from './cli/middleware/with-error-boundary.ts';
import { createProgram } from './cli/program.ts';
import { registerCommands } from './cli/register-commands.ts';

const run = async (): Promise<number> => {
  const program = createProgram();
  registerCommands(program);

  const context = await createContext({
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    flags: program.opts(),
  });

  return withErrorBoundary(context, async (): Promise<void> => {
    await program.parseAsync(process.argv);
  });
};

const main = async (): Promise<void> => {
  const exitCode = await run();
  process.exitCode = exitCode;
};

void main();
