import type { NodeResult } from './emitter.ts';
import { EngineConfigError } from './errors.ts';
import type { ExecutionContext, HeimdallContext, ScopeChain, ScopeEntry } from './nodes/base.ts';

// The expression namespace is closed at these five roots at every expression site.
export interface CelContext extends Record<string, unknown> {
  readonly inputs: Record<string, string | number | bigint | boolean>;
  readonly vars: Record<string, string | number | bigint | boolean>;
  readonly heimdall: HeimdallContext;
  readonly self: Record<string, unknown>;
  readonly scopes: ScopeChain;
}

// Owned by the lifecycle phases and by scope entries, so a node type may not bind them itself.
const RESERVED_SURFACE_KEYS: ReadonlySet<string> = new Set(['needs', 'nodes', 'prev', 'iteration']);

type SurfaceExtension = Readonly<Record<string, unknown>>;

type SystemSurface = Readonly<{
  needs: ReadonlyMap<string, NodeResult>;
  nodes?: ReadonlyMap<string, NodeResult>;
  prev?: ReadonlyMap<string, NodeResult>;
}>;

// Collisions are rejected as the surface is built, before any expression is evaluated.
const mergeSurfaceExtensions = (
  system: SystemSurface,
  groups: readonly SurfaceExtension[]
): Record<string, unknown> => {
  const merged = new Map<string, unknown>(Object.entries(system));

  for (const group of groups) {
    for (const [key, value] of Object.entries(group)) {
      if (RESERVED_SURFACE_KEYS.has(key)) {
        throw new EngineConfigError(`Reserved node-surface key: ${key}`);
      }

      if (merged.has(key)) {
        throw new EngineConfigError(`Duplicate node-surface key: ${key}`);
      }

      merged.set(key, value);
    }
  }

  return Object.fromEntries(merged);
};

// A declared dependency that produced no result (it was skipped) is absent, not undefined.
export const selectNeeds = (
  needs: ReadonlyMap<string, NodeResult>,
  dependencies: readonly string[]
): Map<string, NodeResult> => {
  const selected = new Map<string, NodeResult>();

  for (const id of dependencies) {
    const result = needs.get(id);
    if (result !== undefined) {
      selected.set(id, result);
    }
  }

  return selected;
};

const buildContext = (
  ctx: ExecutionContext,
  self: Readonly<Record<string, unknown>>
): CelContext => ({
  inputs: ctx.inputs,
  vars: ctx.vars,
  heimdall: ctx.heimdall,
  self,
  scopes: ctx.scopes,
});

export const buildEntryContext = (
  ctx: ExecutionContext,
  dependencies: readonly string[]
): CelContext => buildContext(ctx, { needs: selectNeeds(ctx.needs, dependencies) });

export const buildActiveContext = (
  ctx: ExecutionContext,
  dependencies: readonly string[],
  ...extensions: SurfaceExtension[]
): CelContext =>
  buildContext(
    ctx,
    mergeSurfaceExtensions({ needs: selectNeeds(ctx.needs, dependencies) }, extensions)
  );

export const buildCheckpointContext = (
  ctx: ExecutionContext,
  dependencies: readonly string[],
  nodes: ReadonlyMap<string, NodeResult>,
  ...extensions: SurfaceExtension[]
): CelContext =>
  buildContext(
    ctx,
    mergeSurfaceExtensions({ needs: selectNeeds(ctx.needs, dependencies), nodes }, extensions)
  );

// The entry is keyed by the scoped node's own id, so it is visible to its body but never to itself.
export const extendScope = (
  parent: ScopeChain,
  id: string,
  system: SystemSurface,
  ...extensions: SurfaceExtension[]
): ScopeChain => new Map(parent).set(id, mergeSurfaceExtensions(system, extensions) as ScopeEntry);
