import type { NodeResult } from './emitter.ts';
import type { ExecutionContext, HeimdallContext, ScopeChain, ScopeEntry } from './nodes/base.ts';

// The expression namespace is closed at these five roots at every expression site.
export interface CelContext extends Record<string, unknown> {
  readonly inputs: Record<string, string | number | bigint | boolean>;
  readonly vars: Record<string, string | number | bigint | boolean>;
  readonly heimdall: HeimdallContext;
  readonly self: Record<string, unknown>;
  readonly scopes: ScopeChain;
}

// Names the engine owns on every surface. `needs`, `nodes` and `prev` carry node results; the
// retired `iteration` stays blocked so nothing rebinds it to mean something other than `index`.
type ReservedKey = 'needs' | 'nodes' | 'prev' | 'iteration';

// A node type's own attributes, rejected at compile time when they collide with a reserved name.
type Attributes<A> = A & Readonly<Record<Extract<keyof A, ReservedKey>, never>>;

// Narrows the scheduler's map of every completed node to the ones this node declared in
// depends_on. A declared dependency that produced no result (it was skipped) is absent, not
// undefined.
export const selectDeclaredNeeds = (
  completed: ReadonlyMap<string, NodeResult>,
  dependencies: readonly string[]
): Map<string, NodeResult> => {
  const selected = new Map<string, NodeResult>();

  for (const id of dependencies) {
    const result = completed.get(id);
    if (result !== undefined) {
      selected.set(id, result);
    }
  }

  return selected;
};

const withSelf = (ctx: ExecutionContext, self: Readonly<Record<string, unknown>>): CelContext => ({
  inputs: ctx.inputs,
  vars: ctx.vars,
  heimdall: ctx.heimdall,
  self,
  scopes: ctx.scopes,
});

// The three builders below differ only in `self`, because the phase an expression runs in decides
// what is knowable about the node by then.

// Before the node runs: its own `if` and the interpolation of its own fields. Nothing it owns has
// produced anything yet, so `needs` is all it can see.
export const buildEntryContext = (
  ctx: ExecutionContext,
  dependencies: readonly string[]
): CelContext => withSelf(ctx, { needs: selectDeclaredNeeds(ctx.needs, dependencies) });

// While the node is running, once it has provisioned what it owns — a worktree's failure cleanup
// reads the path it just created. Still no body results.
export const buildActiveContext = <A extends object>(
  ctx: ExecutionContext,
  dependencies: readonly string[],
  attributes?: Attributes<A>
): CelContext =>
  withSelf(ctx, { needs: selectDeclaredNeeds(ctx.needs, dependencies), ...attributes });

// A pause where a body execution has finished, so `nodes` holds that latest snapshot: a loop's
// `while`, `until` and `outputs`. Repeatable — a loop reaches one before its first iteration, with
// an empty `nodes`, and again after each one.
export const buildCheckpointContext = <A extends object>(
  ctx: ExecutionContext,
  dependencies: readonly string[],
  nodes: ReadonlyMap<string, NodeResult>,
  attributes?: Attributes<A>
): CelContext =>
  withSelf(ctx, { needs: selectDeclaredNeeds(ctx.needs, dependencies), nodes, ...attributes });

// The entry is keyed by the scoped node's own id, so it is visible to its body but never to itself.
// The node type states its own entry shape, so what a scope carries stays with the node that opens
// it rather than being described here.
export const extendScope = (parent: ScopeChain, id: string, entry: ScopeEntry): ScopeChain =>
  new Map(parent).set(id, entry);
