import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { configHome } from '../../../utils/config-home.ts';
import type { Platform } from '../../platform/index.ts';
import { interpolate } from '../cel.ts';
import { NodeError } from '../errors.ts';
import { buildEntryContext } from '../expression-context.ts';
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
      // case a misbehaving adapter passes a non-string value. Chunks arriving after a terminal
      // event are dropped so a misbehaving adapter can't grow the buffer indefinitely.
      stream.on('chunk', (delta) => {
        if (settled) {
          return;
        }

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
    return Promise.resolve(
      interpolateField(this.prompt, 'prompt', ctx, this.getDependencies(), this.id, this.name)
    );
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
      interpolateField(
        this.instructions ?? '',
        'instructions',
        ctx,
        this.getDependencies(),
        this.id,
        this.name
      )
    );
  }

  // The agent reference supports ${{ }} interpolation but is otherwise forwarded unresolved —
  // the platform owns agent lookup.
  protected override buildExtraOptions(ctx: ExecutionContext): Record<string, unknown> {
    const agent = interpolateField(
      this.agent,
      'agent',
      ctx,
      this.getDependencies(),
      this.id,
      this.name
    );

    // Platforms silently ignore an empty agent reference, so a reference that interpolates to
    // nothing would run without the agent and mask the workflow bug. Fail loudly instead.
    if (agent.trim() === '') {
      throw new NodeError(
        'Agent reference resolved to an empty string',
        'ENGINE_AGENTIC_EMPTY_AGENT',
        this.id,
        { nodeName: this.name }
      );
    }

    return { agent };
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
    const dependencies = this.getDependencies();
    const promptFile = interpolateField(
      this.promptFile,
      'prompt_file',
      ctx,
      dependencies,
      this.id,
      this.name
    );
    const contents = await this.readPromptFile(promptFile, ctx);

    return interpolateField(
      contents,
      'prompt file contents',
      ctx,
      dependencies,
      this.id,
      this.name
    );
  }

  // Reads the first candidate path that exists; fails with the full search list if none do.
  private async readPromptFile(promptFile: string, ctx: ExecutionContext): Promise<string> {
    const candidates = await promptFileCandidates(promptFile, ctx.cwd);

    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        return await readFile(candidate, 'utf8');
      } catch (err) {
        lastError = err;
      }
    }

    const detail = candidates.length > 1 ? `; searched: ${candidates.join(', ')}` : '';
    throw new NodeError(
      `Failed to read prompt file '${promptFile}'${detail}`,
      'ENGINE_PROMPT_FILE_READ_ERROR',
      this.id,
      { nodeName: this.name, cause: lastError }
    );
  }
}

// Candidate prompt_file paths in priority order. Absolute paths are used as-is. Relative paths that
// navigate (a leading `.`/`..` segment, or any `..`) resolve against cwd only and skip the search
// locations entirely, so `..` can't retarget a lookup inside them. Plain relative paths try cwd,
// then each ancestor's .heimdall/prompts directory walking up to the git root (inclusive) or the
// filesystem root, then the global prompts dir under the config home. First existing wins.
const promptFileCandidates = async (promptFile: string, cwd: string): Promise<string[]> => {
  if (isAbsolute(promptFile)) {
    return [promptFile];
  }

  const segments = promptFile.split(/[/\\]/);
  if (segments[0] === '.' || segments.includes('..')) {
    return [resolve(cwd, promptFile)];
  }

  const candidates = [join(cwd, promptFile)];
  let dir = resolve(cwd);
  for (;;) {
    candidates.push(join(dir, '.heimdall', 'prompts', promptFile));

    // `.git` is a file for worktrees and submodules, so existence — not type — marks the git root.
    const isGitRoot = await stat(resolve(dir, '.git')).then(
      () => true,
      () => false
    );
    if (isGitRoot) {
      break;
    }

    const parent = resolve(dir, '..');
    if (parent === dir) {
      break;
    }

    dir = parent;
  }

  candidates.push(join(configHome(), 'heimdall', 'prompts', promptFile));

  return candidates;
};

const interpolateField = (
  template: string,
  field: string,
  ctx: ExecutionContext,
  dependencies: readonly string[],
  nodeId: string,
  nodeName: string | undefined
): string => {
  try {
    return interpolate(template, buildEntryContext(ctx, dependencies));
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
