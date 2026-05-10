import { CliError, EXIT_CODE } from './cli-error.ts';

export const mapUnknownError = (error: unknown): CliError => {
  if (error instanceof CliError) {
    return error;
  }

  if (error instanceof Error) {
    return new CliError('An unexpected error occurred.', {
      code: 'UNKNOWN_ERROR',
      exitCode: EXIT_CODE.UNKNOWN,
      cause: error,
    });
  }

  return new CliError('An unknown error occurred.', {
    code: 'UNKNOWN_ERROR',
    exitCode: EXIT_CODE.UNKNOWN,
    cause: error,
  });
};
