// Side-effect imports: each node module self-registers into the global node
// registry on load. Removing them would leave the registry unable to build
// those node types.
import './nodes/approval.ts';
import './nodes/bash.ts';

import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { load as loadYaml } from 'js-yaml';

import {
  buildContextInheritanceMap,
  topologicalSort,
  validateDependencyReferences,
  validateNoNodeTypes,
  validateSharedContextFanIn,
} from './dag-utils.ts';
import type { EngineEmitter } from './emitter.ts';
import { createEngineEmitter } from './emitter.ts';
import { EngineConfigError, EngineError, EngineValidationError } from './errors.ts';
import type { BaseNode, ExecutionContext, PlatformAdapter } from './nodes/base.ts';
import { BreakNode } from './nodes/break.ts';
import { nodeRegistry } from './nodes/registry.ts';
import { runScheduler } from './scheduler.ts';
import type { InputDeclaration, WorkflowDefinition } from './schema.ts';
import { WorkflowDefinitionSchema } from './schema.ts';

export interface WorkflowRunOptions {
  readonly inputs: Record<string, string | number | bigint | boolean>;
  readonly emitter?: EngineEmitter | undefined;
  readonly cwd: string;
  readonly adapter: PlatformAdapter;
}

export interface WorkflowResult {
  readonly success: boolean;
  readonly exitReason?: string | undefined;
}

/**
 * A parsed, validated workflow ready to execute.
 *
 * The two-step API (parse via {@link Workflow.from}, then {@link Workflow.run})
 * lets callers inspect required inputs and collect values before committing to a
 * run.
 */
export class Workflow {
  private readonly definition: WorkflowDefinition;
  private readonly sortedNodes: BaseNode[];
  private readonly sharedContextMap: Map<string, string>;

  private started = false;

  private constructor(
    definition: WorkflowDefinition,
    sortedNodes: BaseNode[],
    sharedContextMap: Map<string, string>
  ) {
    this.definition = definition;
    this.sortedNodes = sortedNodes;
    this.sharedContextMap = sharedContextMap;
  }

  /**
   * Parse and validate a workflow YAML string into an executable {@link Workflow}.
   *
   * @throws {EngineValidationError} when the YAML is malformed or fails schema validation.
   * @throws {EngineConfigError} when the workflow graph is structurally invalid.
   */
  public static async from(yaml: string): Promise<Workflow> {
    const raw = Workflow.parseYaml(yaml);
    const definition = Workflow.validateDefinition(raw);
    const nodes = Workflow.buildNodes(definition);
    const sortedNodes = Workflow.validateGraph(nodes);
    const sharedContextMap = buildContextInheritanceMap(sortedNodes);

    return new Workflow(definition, sortedNodes, sharedContextMap);
  }

  /**
   * The declared inputs from the workflow definition, keyed by input name.
   * Empty when the workflow declares no inputs.
   */
  public get inputs(): ReadonlyMap<string, InputDeclaration> {
    return new Map(Object.entries(this.definition.inputs ?? {}));
  }

  /**
   * Execute the workflow with the supplied runtime inputs and options.
   *
   * @throws {EngineError} when called more than once on the same instance.
   * @throws {EngineConfigError} when a required input is missing and has no default.
   */
  public async run(options: WorkflowRunOptions): Promise<WorkflowResult> {
    if (this.started) {
      throw new EngineError(
        'Workflow.run() may only be called once per instance',
        'ENGINE_ALREADY_RUN'
      );
    }

    // Resolve inputs before burning the instance: a missing-input failure is a
    // recoverable pre-flight error that commits no side effects, so the caller
    // may retry. Setting `started` synchronously (before the first await) still
    // prevents two concurrent run() calls from both proceeding.
    const resolvedInputs = this.resolveInputs(options.inputs);
    this.started = true;

    const emitter = options.emitter ?? createEngineEmitter();

    // An empty/blank XDG_DATA_HOME must fall back to the default absolute path,
    // otherwise the run dir would resolve relative to cwd.
    const xdgDataHome = process.env['XDG_DATA_HOME']?.trim();
    const dataHome =
      xdgDataHome === undefined || xdgDataHome === ''
        ? join(homedir(), '.local', 'share')
        : xdgDataHome;
    const runDir = join(dataHome, 'heimdall', 'runs', randomUUID());
    const sessionDir = join(runDir, 'session');

    let result: WorkflowResult | undefined;

    try {
      await mkdir(sessionDir, { recursive: true });

      const ctx: ExecutionContext = {
        inputs: resolvedInputs,
        vars: this.definition.vars ?? {},
        needs: new Map(),
        sessionDir,
        scope: undefined,
      };

      result = await runScheduler(this.sortedNodes, ctx, {
        adapter: options.adapter,
        emitter,
        sharedContextMap: this.sharedContextMap,
      });

      // Preserve the run dir on failure so session artifacts remain available
      // for post-mortem debugging; remove it only on success.
      if (result.success) {
        await rm(runDir, { recursive: true, force: true });
      }

      return { success: result.success, exitReason: result.exitReason };
    } finally {
      // workflow_completed must always be the terminal event, even when mkdir,
      // the scheduler, or teardown throw. `result?.success ?? false` reports
      // failure when we never reached a scheduler result.
      emitter.emit('workflow_completed', { success: result?.success ?? false });
    }
  }

  private resolveInputs(
    runtimeInputs: Record<string, string | number | bigint | boolean>
  ): Record<string, string | number | bigint | boolean> {
    const declared = this.definition.inputs ?? {};
    const resolved: Record<string, string | number | bigint | boolean> = {};
    const missing: string[] = [];

    for (const [name, declaration] of Object.entries(declared)) {
      if (name in runtimeInputs) {
        resolved[name] = runtimeInputs[name]!;
      } else if (declaration.default !== undefined) {
        resolved[name] = declaration.default;
      } else {
        missing.push(name);
      }
    }

    if (missing.length > 0) {
      throw new EngineConfigError(
        `Missing required input(s): ${missing.map((name) => `'${name}'`).join(', ')}`
      );
    }

    return resolved;
  }

  private static parseYaml(yaml: string): unknown {
    try {
      return loadYaml(yaml);
    } catch (err) {
      throw new EngineValidationError('Failed to parse workflow YAML', { cause: err });
    }
  }

  private static validateDefinition(raw: unknown): WorkflowDefinition {
    const result = WorkflowDefinitionSchema.safeParse(raw);

    if (!result.success) {
      throw new EngineValidationError('Workflow failed schema validation', { cause: result.error });
    }

    return result.data;
  }

  private static buildNodes(definition: WorkflowDefinition): BaseNode[] {
    // Each node is an open object (id + arbitrary fields); the registry matches its
    // discriminant and runs the node-type-specific schema to construct the typed node.
    return definition.nodes.map((node) => nodeRegistry.parseNode(node));
  }

  private static validateGraph(nodes: BaseNode[]): BaseNode[] {
    validateDependencyReferences(nodes);
    validateSharedContextFanIn(nodes);
    const sortedNodes = topologicalSort(nodes);
    // BreakNode is only meaningful inside a loop body; at top level there is no
    // loop to break, so its presence is a workflow authoring error.
    validateNoNodeTypes(nodes, [BreakNode]);

    for (const node of nodes) {
      node.validate();
    }

    return sortedNodes;
  }
}
