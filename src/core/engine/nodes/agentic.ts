import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Platform } from '../../platform/index.ts';
import { interpolate } from '../cel.ts';
import { NodeError } from '../errors.ts';
import type { AgenticBaseNode as ParsedAgenticBase } from '../schema.ts';
import { AgentNodeSchema, PromptFileNodeSchema, PromptNodeSchema } from '../schema.ts';
import type {
  BaseNodeData,
  ExecutionContext,
  NodeRunCompleted,
  NodeRunFailed,
  NodeRunOptions,
  PlatformStream,
} from './base.ts';
import { BaseNode } from './base.ts';
import { nodeRegistry } from './registry.ts';

interface AgenticNodeResult extends Record<string, unknown> {
  output: string | Record<string, unknown>;
}

interface AgenticNodeData extends BaseNodeData {
  platform?: Platform | undefined;
  platformOptions?: Record<string, unknown> | undefined;
  context?: 'clean' | 'shared' | undefined;
  outputFormat?: Record<string, unknown> | undefined;
}

const toAgenticNodeData = (data: ParsedAgenticBase): AgenticNodeData => ({
  id: data.id,
  ...(data.name !== undefined ? { name: data.name } : {}),
  ...(data.depends_on !== undefined ? { depends_on: data.depends_on } : {}),
  ...(data.if !== undefined ? { if: data.if } : {}),
  ...(data.timeout !== undefined ? { timeout: data.timeout } : {}),
  ...(data.retries !== undefined ? { retries: data.retries } : {}),
  platform: data.platform,
  platformOptions: data.platform_options,
  context: data.context ?? 'clean',
  outputFormat: data.output_format,
});

export abstract class AgenticNode extends BaseNode<NodeRunCompleted | NodeRunFailed> {
  public readonly platform: Platform | undefined;
  public readonly platformOptions: Record<string, unknown> | undefined;
  public readonly context: 'clean' | 'shared';
  public readonly outputFormat: Record<string, unknown> | undefined;

  public constructor(data: AgenticNodeData) {
    super(data);
    this.platform = data.platform;
    this.platformOptions = data.platformOptions;
    this.context = data.context ?? 'clean';
    this.outputFormat = data.outputFormat;
  }

  public override isAgentic(): boolean {
    return true;
  }

  public override useSharedContext(): boolean {
    return this.context === 'shared';
  }

  /** Builds the interpolated (or file-derived) prompt dispatched to the adapter. */
  protected abstract resolvePrompt(ctx: ExecutionContext): Promise<string>;

  /**
   * Subclass-specific adapter options merged on top of platform option defaults. `ctx` is
   * provided so subclasses can interpolate option fields (e.g. AgentNode's agent reference).
   */
  protected buildExtraOptions(_ctx: ExecutionContext): Record<string, unknown> {
    return {};
  }

  public override async run(options: NodeRunOptions): Promise<NodeRunCompleted | NodeRunFailed> {
    const { ctx, platform: runtime, signal, predecessorSessionId } = options;

    if (runtime === undefined) {
      throw new NodeError(
        'Platform runtime is unavailable',
        'ENGINE_AGENTIC_NO_PLATFORM',
        this.id,
        { nodeName: this.name }
      );
    }

    const prompt = await this.resolvePrompt(ctx);

    const platform = this.platform ?? runtime.defaultPlatform;

    const adapterOptions: Record<string, unknown> = {
      ...(runtime.defaultPlatformOptions ?? {}),
      ...(this.platformOptions ?? {}),
      ...this.buildExtraOptions(ctx),
    };
    if (this.outputFormat !== undefined) {
      adapterOptions['output_format'] = this.outputFormat;
    }

    const sessionId = this.useSharedContext() ? predecessorSessionId : undefined;

    const adapter = await runtime.factory(platform, ctx.cwd);
    const stream = adapter.run(prompt, adapterOptions, sessionId);

    return this.consumeStream(stream, signal);
  }

  private consumeStream(
    stream: PlatformStream,
    signal: AbortSignal
  ): Promise<NodeRunCompleted | NodeRunFailed> {
    // Prevent an unhandled rejection: sessionId() rejects on cancellation, and we only await it
    // after a clean 'done'.
    stream.sessionId().catch(() => undefined);

    return new Promise<NodeRunCompleted | NodeRunFailed>((resolvePromise) => {
      let buffer = '';
      let settled = false;

      const onAbort = (): void => {
        stream.cancel();
      };

      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
      };

      // Enforces "first terminal event wins": the first of done/error to claim owns the
      // settlement, so a later terminal event (or an abort firing during the done handler's
      // async gap) can't override it, and a misbehaving adapter can't double-settle.
      const claim = (): boolean => {
        if (settled) {
          return false;
        }

        settled = true;
        cleanup();

        return true;
      };

      // PlatformStream.on() types all handler args as unknown[]; String() coerces the delta in
      // case a misbehaving adapter passes a non-string value.
      stream.on('chunk', (delta) => {
        buffer += String(delta);
      });

      stream.on('done', () => {
        // Claim synchronously so a later error or abort can't override this completed run during
        // the sessionId() await below; snapshot the buffer so late chunks can't mutate the output.
        if (!claim()) {
          return;
        }

        const output = buffer;
        void (async (): Promise<void> => {
          const sessionId = await stream.sessionId().catch(() => undefined);
          const result: AgenticNodeResult = { output };
          resolvePromise({
            status: 'completed',
            result,
            ...(sessionId !== undefined ? { sessionId } : {}),
          });
        })();
      });

      stream.on('error', (err) => {
        if (claim()) {
          resolvePromise({ status: 'failed', error: err });
        }
      });

      if (signal.aborted) {
        stream.cancel();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}

export class PromptNode extends AgenticNode {
  private readonly prompt: string;

  public static matches(raw: Record<string, unknown>): boolean {
    return 'prompt' in raw;
  }

  public static parse(raw: Record<string, unknown>): PromptNode {
    const data = PromptNodeSchema.parse(raw);

    return new PromptNode({ ...toAgenticNodeData(data), prompt: data.prompt });
  }

  public constructor(data: AgenticNodeData & { prompt: string }) {
    super(data);
    this.prompt = data.prompt;
  }

  protected override resolvePrompt(ctx: ExecutionContext): Promise<string> {
    return Promise.resolve(interpolateField(this.prompt, 'prompt', ctx, this.id, this.name));
  }
}

export class AgentNode extends AgenticNode {
  private readonly agent: string;
  private readonly instructions: string | undefined;

  public static matches(raw: Record<string, unknown>): boolean {
    return 'agent' in raw;
  }

  public static parse(raw: Record<string, unknown>): AgentNode {
    const data = AgentNodeSchema.parse(raw);

    return new AgentNode({
      ...toAgenticNodeData(data),
      agent: data.agent,
      instructions: data.instructions,
    });
  }

  public constructor(data: AgenticNodeData & { agent: string; instructions: string | undefined }) {
    super(data);
    this.agent = data.agent;
    this.instructions = data.instructions;
  }

  protected override resolvePrompt(ctx: ExecutionContext): Promise<string> {
    return Promise.resolve(
      interpolateField(this.instructions ?? '', 'instructions', ctx, this.id, this.name)
    );
  }

  // The agent reference supports ${{ }} interpolation but is otherwise forwarded unresolved —
  // the adapter owns agent lookup.
  protected override buildExtraOptions(ctx: ExecutionContext): Record<string, unknown> {
    return { agent: interpolateField(this.agent, 'agent', ctx, this.id, this.name) };
  }
}

export class PromptFileNode extends AgenticNode {
  private readonly promptFile: string;

  public static matches(raw: Record<string, unknown>): boolean {
    return 'prompt_file' in raw;
  }

  public static parse(raw: Record<string, unknown>): PromptFileNode {
    const data = PromptFileNodeSchema.parse(raw);

    return new PromptFileNode({ ...toAgenticNodeData(data), promptFile: data.prompt_file });
  }

  public constructor(data: AgenticNodeData & { promptFile: string }) {
    super(data);
    this.promptFile = data.promptFile;
  }

  protected override async resolvePrompt(ctx: ExecutionContext): Promise<string> {
    const promptFile = interpolateField(this.promptFile, 'prompt_file', ctx, this.id, this.name);
    const path = resolve(ctx.cwd, promptFile);

    let contents: string;
    try {
      contents = await readFile(path, 'utf8');
    } catch (err) {
      throw new NodeError(
        `Failed to read prompt file '${promptFile}'`,
        'ENGINE_PROMPT_FILE_READ_ERROR',
        this.id,
        { nodeName: this.name, cause: err }
      );
    }

    return interpolateField(contents, 'prompt file contents', ctx, this.id, this.name);
  }
}

const interpolateField = (
  template: string,
  field: string,
  ctx: ExecutionContext,
  nodeId: string,
  nodeName: string | undefined
): string => {
  try {
    return interpolate(template, ctx as unknown as Record<string, unknown>);
  } catch (err) {
    throw new NodeError(
      `Failed to interpolate ${field}`,
      'ENGINE_AGENTIC_INTERPOLATION_ERROR',
      nodeId,
      { nodeName, cause: err }
    );
  }
};

nodeRegistry.register(PromptNode);
nodeRegistry.register(AgentNode);
nodeRegistry.register(PromptFileNode);
