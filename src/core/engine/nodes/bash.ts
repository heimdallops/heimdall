import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';

import { interpolate } from '../cel.ts';
import { NodeError } from '../errors.ts';
import { buildEntryContext } from '../expression-context.ts';
import { BashNodeSchema } from '../schema.ts';
import type { BaseNodeData, NodeRunCompleted, NodeRunFailed, NodeRunOptions } from './base.ts';
import { BaseNode } from './base.ts';
import { nodeRegistry } from './registry.ts';

class OutputFile implements AsyncDisposable {
  public readonly fh: FileHandle;
  public readonly path: string;

  private constructor(fh: FileHandle, path: string) {
    this.fh = fh;
    this.path = path;
  }

  public static async create(): Promise<OutputFile> {
    const path = join(tmpdir(), `heimdall-bash-output-${randomUUID()}`);
    const fh = await open(path, 'wx+', 0o600);

    return new OutputFile(fh, path);
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.fh.close().catch(() => undefined);
    await rm(this.path, { force: true }).catch(() => undefined);
  }
}

interface BashNodeResult extends Record<string, unknown> {
  output: unknown;
}

interface BashNodeData extends BaseNodeData {
  bash: string;
  env: Record<string, string> | undefined;
  outputFormat: 'text' | 'json';
}

export class BashNode extends BaseNode<NodeRunCompleted | NodeRunFailed> {
  private readonly bash: string;
  private readonly env: Record<string, string> | undefined;
  private readonly outputFormat: 'text' | 'json';

  public static matches(raw: Record<string, unknown>): boolean {
    return 'bash' in raw;
  }

  public static parse(raw: Record<string, unknown>): BashNode {
    const data = BashNodeSchema.parse(raw);

    return new BashNode({
      id: data.id,
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.depends_on !== undefined ? { depends_on: data.depends_on } : {}),
      ...(data.if !== undefined ? { if: data.if } : {}),
      ...(data.timeout !== undefined ? { timeout: data.timeout } : {}),
      ...(data.retries !== undefined ? { retries: data.retries } : {}),
      bash: data.bash,
      env: data.env,
      outputFormat: data.output_format ?? 'text',
    });
  }

  public constructor(data: BashNodeData) {
    super(data);
    this.bash = data.bash;
    this.env = data.env;
    this.outputFormat = data.outputFormat;
  }

  public override async run(options: NodeRunOptions): Promise<NodeRunCompleted | NodeRunFailed> {
    const { ctx, signal } = options;
    const celContext = buildEntryContext(ctx, this.getDependencies());

    let interpolatedBash: string;
    try {
      interpolatedBash = interpolate(this.bash, celContext);
    } catch (err) {
      throw new NodeError(
        'Failed to interpolate bash script',
        'ENGINE_BASH_INTERPOLATION_ERROR',
        this.id,
        { nodeName: this.name, cause: err }
      );
    }

    let interpolatedEnv: Record<string, string> | undefined;
    if (this.env) {
      interpolatedEnv = {};
      try {
        for (const [key, value] of Object.entries(this.env)) {
          interpolatedEnv[key] = interpolate(value, celContext);
        }
      } catch (err) {
        throw new NodeError(
          'Failed to interpolate bash env values',
          'ENGINE_BASH_INTERPOLATION_ERROR',
          this.id,
          { nodeName: this.name, cause: err }
        );
      }
    }

    // Keep the fd open so the script writes and we read via the same handle, avoiding a TOCTOU race on the tmp path.
    await using outputFile = await OutputFile.create();

    const execResult = await execa('bash', ['-c', interpolatedBash], {
      cwd: ctx.cwd,
      env: {
        ...process.env,
        ...interpolatedEnv,
        HEIMDALL_OUTPUT: outputFile.path,
      },
      cancelSignal: signal,
      reject: false,
      stdout: 'inherit',
      stderr: 'inherit',
    });

    // Aborted via cancelSignal — surface a failed result rather than a NodeError since the abort, not the exit code, is the cause.
    if (execResult.isCanceled) {
      return { status: 'failed', error: execResult };
    }

    // execa leaves exitCode undefined in exactly two cases: the process never spawned, or a signal terminated it.
    if (execResult.exitCode === undefined && !execResult.isTerminated) {
      throw new NodeError('Bash script failed to start', 'ENGINE_BASH_SPAWN_ERROR', this.id, {
        nodeName: this.name,
        cause: execResult,
      });
    }

    if (execResult.exitCode !== 0) {
      throw new NodeError(
        `Bash script exited with code ${execResult.exitCode}`,
        'ENGINE_BASH_NONZERO_EXIT',
        this.id,
        { nodeName: this.name }
      );
    }

    // Strip trailing newlines: shells always append one, and it breaks JSON.parse for json mode.
    const rawContent = (await outputFile.fh.readFile({ encoding: 'utf8' })).replace(/[\r\n]+$/, '');

    let output: unknown;
    if (this.outputFormat === 'json') {
      if (rawContent === '') {
        output = null;
      } else {
        try {
          output = JSON.parse(rawContent);
        } catch (err) {
          throw new NodeError(
            'Failed to parse HEIMDALL_OUTPUT as JSON',
            'ENGINE_BASH_JSON_PARSE_ERROR',
            this.id,
            { nodeName: this.name, cause: err }
          );
        }
      }
    } else {
      output = rawContent;
    }

    const result: BashNodeResult = { output };

    return { status: 'completed', result };
  }
}

nodeRegistry.register(BashNode);
