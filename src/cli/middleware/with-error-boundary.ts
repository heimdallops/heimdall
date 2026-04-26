import { EXIT_CODE } from '../../errors/cli-error.ts';
import { mapUnknownError } from '../../errors/map-error.ts';
import type { CliContext } from '../context.ts';

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
  context: CliContext,
  run: () => Promise<T>
): Promise<number> => {
  try {
    await run();
    return 0;
  } catch (error) {
    const commanderError = getCommanderError(error);

    if (commanderError?.code === 'commander.helpDisplayed') {
      return EXIT_CODE.SUCCESS;
    }

    if (commanderError?.code?.startsWith('commander.')) {
      return commanderError.exitCode ?? EXIT_CODE.USAGE;
    }

    const mapped = mapUnknownError(error);
    context.printer.error(`[${mapped.code}] ${mapped.message}`);
    return mapped.exitCode;
  }
};
