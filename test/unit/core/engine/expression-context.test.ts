import { describe, expect, it } from 'vitest';

import { evalCel } from '../../../../src/core/engine/cel.ts';
import type { NodeResult } from '../../../../src/core/engine/emitter.ts';
import type { EngineError } from '../../../../src/core/engine/errors.ts';
import {
  buildActiveContext,
  buildCheckpointContext,
  buildEntryContext,
  extendScope,
  selectDeclaredNeeds,
} from '../../../../src/core/engine/expression-context.ts';
import type {
  ExecutionContext,
  LoopScopeEntry,
  ScopeChain,
  WorktreeScopeEntry,
} from '../../../../src/core/engine/nodes/base.ts';

const makeCtx = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
  inputs: {},
  vars: {},
  needs: new Map(),
  cwd: '/tmp/work',
  heimdall: { run_cwd: '/tmp/work', session_dir: '/tmp/session' },
  scopes: new Map(),
  ...overrides,
});

// Runs fn and returns the thrown error, or fails the test loudly if fn does not throw.
const captureThrown = (fn: () => unknown): EngineError => {
  try {
    fn();
  } catch (err) {
    return err as EngineError;
  }

  throw new Error('expected function to throw');
};

describe('the five-root CEL namespace', () => {
  it('binds exactly inputs, vars, heimdall, self, scopes at an entry site', () => {
    const built = buildEntryContext(makeCtx(), []);

    expect(Object.keys(built).sort()).toEqual(['heimdall', 'inputs', 'scopes', 'self', 'vars']);
  });

  it('binds exactly inputs, vars, heimdall, self, scopes at an active site', () => {
    const built = buildActiveContext(makeCtx(), []);

    expect(Object.keys(built).sort()).toEqual(['heimdall', 'inputs', 'scopes', 'self', 'vars']);
  });

  it('binds exactly inputs, vars, heimdall, self, scopes at a checkpoint site', () => {
    const built = buildCheckpointContext(makeCtx(), [], new Map());

    expect(Object.keys(built).sort()).toEqual(['heimdall', 'inputs', 'scopes', 'self', 'vars']);
  });

  it('fails to resolve a root name outside the five closed roots', () => {
    const built = buildEntryContext(makeCtx(), []);

    const error = captureThrown(() => evalCel('bogus', built));

    expect(error.code).toBe('ENGINE_CEL_ERROR');
    expect(error.message).toBe('CEL evaluation failed');
    expect(evalCel('has(self.needs.anything)', built)).toBe(false);
  });
});

describe('self.needs projection', () => {
  it("resolves a declared dependency's completed result under self.needs", () => {
    const ctx = makeCtx({ needs: new Map<string, NodeResult>([['build', { exitCode: 0 }]]) });

    const built = buildEntryContext(ctx, ['build']);

    expect(evalCel('self.needs.build.exitCode', built)).toBe(0);
  });

  it('fails reading a completed node that the current node does not declare as a dependency', () => {
    const ctx = makeCtx({
      needs: new Map<string, NodeResult>([
        ['build', { exitCode: 0 }],
        ['lint', { passed: true }],
      ]),
    });
    const built = buildEntryContext(ctx, ['build']);

    const error = captureThrown(() => evalCel('self.needs.lint.passed', built));

    expect(error.code).toBe('ENGINE_CEL_ERROR');
    expect(evalCel('self.needs.build.exitCode', built)).toBe(0);
  });

  it('excludes a declared dependency that produced no result', () => {
    const ctx = makeCtx({ needs: new Map<string, NodeResult>([['build', { exitCode: 0 }]]) });
    const built = buildEntryContext(ctx, ['build', 'lint']);

    const error = captureThrown(() => evalCel('self.needs.lint', built));

    expect(error.code).toBe('ENGINE_CEL_ERROR');
    expect(evalCel('self.needs.build.exitCode', built)).toBe(0);
  });

  it('binds self.needs empty when the node declares no dependencies, so has() answers false', () => {
    const ctx = makeCtx({ needs: new Map<string, NodeResult>([['build', { exitCode: 0 }]]) });
    const built = buildEntryContext(ctx, []);

    expect(evalCel('has(self.needs.build)', built)).toBe(false);
  });
});

describe('self.nodes presence by lifecycle phase', () => {
  it('has no nodes channel on self at an entry site', () => {
    const built = buildEntryContext(makeCtx(), []);

    expect(evalCel('has(self.nodes)', built)).toBe(false);
    const error = captureThrown(() => evalCel('self.nodes.child', built));
    expect(error.code).toBe('ENGINE_CEL_ERROR');
  });

  it('has no nodes channel on self at an active site', () => {
    const built = buildActiveContext(makeCtx(), []);

    expect(evalCel('has(self.nodes)', built)).toBe(false);
    const error = captureThrown(() => evalCel('self.nodes.child', built));
    expect(error.code).toBe('ENGINE_CEL_ERROR');
  });

  it('resolves self.nodes.<id> at a checkpoint site', () => {
    const built = buildCheckpointContext(
      makeCtx(),
      [],
      new Map<string, NodeResult>([['child', { ok: true }]])
    );

    expect(evalCel('self.nodes.child.ok', built)).toBe(true);
  });
});

describe('loop counters are vantage-specific', () => {
  it('resolves self.iterations at a checkpoint built with an iterations extension', () => {
    const built = buildCheckpointContext(makeCtx(), [], new Map(), { iterations: 3 });

    expect(evalCel('self.iterations', built)).toBe(3);
  });

  it('does not bind self.index at a checkpoint; index belongs to the loop scope entry, not self', () => {
    const built = buildCheckpointContext(makeCtx(), [], new Map(), { iterations: 3 });

    const error = captureThrown(() => evalCel('self.index', built));

    expect(error.code).toBe('ENGINE_CEL_ERROR');
    expect(evalCel('self.iterations', built)).toBe(3);
  });

  it('exposes index and prev on a scope entry built for a loop body node', () => {
    const scopes = extendScope(new Map(), 'loop1', {
      needs: new Map(),
      prev: new Map<string, NodeResult>([['prevBody', { ok: true }]]),
      index: 2n,
    } satisfies LoopScopeEntry);
    const built = buildEntryContext(makeCtx({ scopes }), []);

    expect(evalCel('scopes.loop1.index', built)).toBe(2n);
    expect(evalCel('scopes.loop1.prev.prevBody.ok', built)).toBe(true);
  });

  it('does not bind iterations on a loop scope entry; that counter belongs to self at the checkpoint', () => {
    const scopes = extendScope(new Map(), 'loop1', {
      needs: new Map(),
      prev: new Map(),
      index: 2n,
    } satisfies LoopScopeEntry);
    const built = buildEntryContext(makeCtx({ scopes }), []);

    const error = captureThrown(() => evalCel('scopes.loop1.iterations', built));

    expect(error.code).toBe('ENGINE_CEL_ERROR');
    expect(evalCel('scopes.loop1.index', built)).toBe(2n);
  });
});

describe('checkpoint nodes across a repeatable loop lifecycle', () => {
  it("binds an empty nodes map at the checkpoint evaluated before the loop's first iteration", () => {
    const built = buildCheckpointContext(makeCtx(), [], new Map(), { iterations: 0 });

    expect(evalCel('has(self.nodes.body)', built)).toBe(false);
    expect(evalCel('self.iterations', built)).toBe(0);
  });

  it('binds accumulated nodes at the checkpoint evaluated after an iteration completes', () => {
    const built = buildCheckpointContext(
      makeCtx(),
      [],
      new Map<string, NodeResult>([['body', { ok: true }]]),
      { iterations: 1 }
    );

    expect(evalCel('self.nodes.body.ok', built)).toBe(true);
    expect(evalCel('self.iterations', built)).toBe(1);
  });
});

describe('scopes pass-through', () => {
  it('passes the same scope entries through unmodified at entry, active, and checkpoint sites', () => {
    const scopeEntry = {
      needs: new Map<string, NodeResult>([['ancestorDep', { ok: true }]]),
      index: 4,
      prev: new Map(),
    };
    const scopes: ScopeChain = new Map([['loop1', scopeEntry]]);
    const ctx = makeCtx({ scopes });

    const built = [
      buildEntryContext(ctx, []),
      buildActiveContext(ctx, []),
      buildCheckpointContext(ctx, [], new Map()),
    ];

    for (const context of built) {
      expect(Array.from(context.scopes.keys())).toEqual(['loop1']);
      expect(context.scopes.get('loop1')).toBe(scopeEntry);
    }
  });

  it('resolves a scopes.<ancestor_id> field through evalCel', () => {
    const scopeEntry = {
      needs: new Map<string, NodeResult>([['ancestorDep', { ok: true }]]),
      index: 4,
      prev: new Map(),
    };
    const built = buildEntryContext(makeCtx({ scopes: new Map([['loop1', scopeEntry]]) }), []);

    expect(evalCel('scopes.loop1.needs.ancestorDep.ok', built)).toBe(true);
    expect(evalCel('scopes.loop1.index', built)).toBe(4);
  });

  it('fails a read of an id no ancestor carries, rather than resolving it to an enclosing scope', () => {
    const scopeEntry = {
      needs: new Map(),
      index: 0n,
      prev: new Map(),
    } satisfies LoopScopeEntry;
    const built = buildEntryContext(makeCtx({ scopes: new Map([['ci', scopeEntry]]) }), []);

    expect(evalCel('has(scopes.typo)', built)).toBe(false);
    const error = captureThrown(() => evalCel('scopes.typo.index', built));
    expect(error.code).toBe('ENGINE_CEL_ERROR');
    expect(evalCel('scopes.ci.index', built)).toBe(0n);
  });

  it('binds scopes empty at a top-level node so has() answers false but a direct read throws', () => {
    const built = buildEntryContext(makeCtx(), []);

    expect(evalCel('has(scopes.loop1)', built)).toBe(false);
    const error = captureThrown(() => evalCel('scopes.loop1.index', built));
    expect(error.code).toBe('ENGINE_CEL_ERROR');
  });
});

describe('selectDeclaredNeeds', () => {
  it('returns only the declared dependency ids that have results', () => {
    const needs = new Map<string, NodeResult>([
      ['build', { exitCode: 0 }],
      ['lint', { passed: true }],
    ]);

    const selected = selectDeclaredNeeds(needs, ['build']);

    expect(Array.from(selected.entries())).toEqual([['build', { exitCode: 0 }]]);
  });

  it('drops a declared id that produced no result', () => {
    const needs = new Map<string, NodeResult>([['build', { exitCode: 0 }]]);

    const selected = selectDeclaredNeeds(needs, ['build', 'lint']);

    expect(selected.has('lint')).toBe(false);
    expect(selected.get('build')).toEqual({ exitCode: 0 });
  });

  it('ignores a completed node id that is not declared as a dependency', () => {
    const needs = new Map<string, NodeResult>([
      ['build', { exitCode: 0 }],
      ['lint', { passed: true }],
    ]);

    const selected = selectDeclaredNeeds(needs, ['build']);

    expect(selected.size).toBe(1);
    expect(selected.has('lint')).toBe(false);
  });

  it('returns an empty map for an empty dependency list', () => {
    const needs = new Map<string, NodeResult>([['build', { exitCode: 0 }]]);

    const selected = selectDeclaredNeeds(needs, []);

    expect(selected.size).toBe(0);
  });
});

describe('extendScope', () => {
  it('adds one entry under the given id without mutating the parent scope chain', () => {
    const parentEntry = { needs: new Map() };
    const parent: ScopeChain = new Map([['outer', parentEntry]]);

    const next = extendScope(parent, 'inner', {
      needs: new Map(),
      path: '/work',
      base_commit: 'abc123',
    } satisfies WorktreeScopeEntry);

    expect(parent.size).toBe(1);
    expect(parent.has('inner')).toBe(false);
    expect(Array.from(next.keys())).toEqual(['outer', 'inner']);
    expect(next.get('outer')).toBe(parentEntry);
  });

  it('accumulates a flat scope chain across nested extension calls', () => {
    const outerScopes = extendScope(new Map(), 'outer', {
      needs: new Map(),
      path: '/outer',
      base_commit: 'abc123',
    } satisfies WorktreeScopeEntry);
    const innerScopes = extendScope(outerScopes, 'inner', {
      needs: new Map(),
      prev: new Map(),
      index: 0n,
    } satisfies LoopScopeEntry);

    const built = buildEntryContext(makeCtx({ scopes: innerScopes }), []);

    expect(evalCel('scopes.outer.path', built)).toBe('/outer');
    expect(evalCel('scopes.inner.index', built)).toBe(0n);
  });
});
