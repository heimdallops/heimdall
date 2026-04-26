import { CliError, EXIT_CODE } from '../../errors/cli-error.ts';
import type { CliContext } from '../context.ts';

export const withSignalHandling = async <T>(
  _context: CliContext,
  run: (signal: AbortSignal) => T | Promise<T>
): Promise<T> => {
  const controller = new AbortController();

  const onSignal = (): void => {
    controller.abort();
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new CliError('Operation cancelled by signal.', {
        code: 'CANCELLED',
        exitCode: EXIT_CODE.USAGE,
        cause: error,
      });
    }

    throw error;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
};
