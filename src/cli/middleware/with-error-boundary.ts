import { EXIT_CODE } from '../../errors/cli-error.ts';
import { mapUnknownError } from '../../errors/map-error.ts';
import type { Printer } from '../../output/printer.ts';

const getCommanderError = (error: unknown): { code?: string; exitCode?: number } | null => {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const candidate = error as { code?: unknown; exitCode?: unknown };
  const result: { code?: string; exitCode?: number } = {};

  if (typeof candidate.code === 'string') {
    result.code = candidate.code;
  }

  if (typeof candidate.exitCode === 'number') {
    result.exitCode = candidate.exitCode;
  }

  return result;
};

export const withErrorBoundary = async <T>(
  printer: Printer,
  run: () => Promise<T>
): Promise<number> => {
  try {
    await run();

    return EXIT_CODE.SUCCESS;
  } catch (error) {
    const commanderError = getCommanderError(error);

    if (commanderError?.code === 'commander.helpDisplayed') {
      return EXIT_CODE.SUCCESS;
    }

    if (commanderError?.code?.startsWith('commander.')) {
      return commanderError.exitCode ?? EXIT_CODE.USAGE;
    }

    const mapped = mapUnknownError(error);
    printer.error(`[${mapped.code}] ${mapped.message}`);

    if (mapped.code === 'UNKNOWN_ERROR') {
      // Raw detail lives on cause to avoid leaking internals via mapped.message.
      // If this error was caught before createContext() ran (e.g., during config
      // loading), the printer is the bootstrap instance and debug() is a no-op.
      const rawMessage =
        mapped.cause instanceof Error ? mapped.cause.message : String(mapped.cause);
      printer.debug(`[${mapped.code}] ${rawMessage}`);
    }

    return mapped.exitCode;
  }
};
