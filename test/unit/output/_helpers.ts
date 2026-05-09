import { PassThrough } from 'node:stream';

export class TtyPassThrough extends PassThrough {
  isTTY = true;
}

export class NonTtyPassThrough extends PassThrough {
  isTTY = false;
}

/**
 * Create a PassThrough stream that is explicitly NOT a TTY.
 * Chalk checks isTTY on the destination stream to decide whether to emit ANSI
 * color codes; setting it to false here ensures test assertions see plain text
 * without stripping colors manually.
 */
export const makeNonTtyStream = (): PassThrough => {
  return new NonTtyPassThrough();
};

/**
 * Collect all chunks written to a PassThrough into a single UTF-8 string.
 * Callers must end() the stream before awaiting.
 */
export const collectOutput = (stream: PassThrough): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });

/** Strip ANSI CSI escape sequences from a string for readable assertions. */
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/**
 * Write a single log call, flush the stream, and return the stripped output.
 *
 * No explicit flush or intermediate await is needed between writeFn() and
 * stderr.end() because chalk writes synchronously to PassThrough destinations.
 * The end() call drains any buffered chunks before collectOutput resolves.
 */
export const captureOutput = async (writeFn: () => void, stderr: PassThrough): Promise<string> => {
  writeFn();
  stderr.end();
  const raw = await collectOutput(stderr);

  return stripAnsi(raw);
};
