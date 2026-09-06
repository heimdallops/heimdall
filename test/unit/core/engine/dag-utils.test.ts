import { describe, expect, it } from 'vitest';

import {
  buildContextInheritanceMap,
  RESERVED_SCOPED_IDS,
  topologicalSort,
  validateDependencyReferences,
  validateNodeIds,
  validateNoNodeTypes,
  validateSharedContextFanIn,
} from '../../../../src/core/engine/dag-utils.ts';
import { EngineConfigError } from '../../../../src/core/engine/errors.ts';
import type {
  BaseNodeData,
  NodeRunOptions,
  NodeRunResult,
} from '../../../../src/core/engine/nodes/base.ts';
import { BaseNode } from '../../../../src/core/engine/nodes/base.ts';

class StubNode extends BaseNode {
  public run(_options: NodeRunOptions): Promise<NodeRunResult> {
    return Promise.resolve({ status: 'completed', result: {} });
  }
}

class BreakLikeNode extends BaseNode {
  public run(_options: NodeRunOptions): Promise<NodeRunResult> {
    return Promise.resolve({ status: 'completed', result: {} });
  }
}

class ApprovalLikeNode extends BaseNode {
  public run(_options: NodeRunOptions): Promise<NodeRunResult> {
    return Promise.resolve({ status: 'completed', result: {} });
  }
}

class AgenticStubNode extends BaseNode {
  public override isAgentic(): boolean {
    return true;
  }

  public run(_options: NodeRunOptions): Promise<NodeRunResult> {
    return Promise.resolve({ status: 'completed', result: {} });
  }
}

class SharedContextNode extends BaseNode {
  public override isAgentic(): boolean {
    return true;
  }

  public override useSharedContext(): boolean {
    return true;
  }

  public run(_options: NodeRunOptions): Promise<NodeRunResult> {
    return Promise.resolve({ status: 'completed', result: {} });
  }
}

class NonAgenticSharedContextNode extends BaseNode {
  public override useSharedContext(): boolean {
    return true;
  }

  public run(_options: NodeRunOptions): Promise<NodeRunResult> {
    return Promise.resolve({ status: 'completed', result: {} });
  }
}

// A generic scoped node, standing in for any concrete node that overrides
// isScopedNode()/getScopeBody() (e.g. LoopNode), so these tests don't depend
// on a specific node type.
interface ScopedStubNodeData extends BaseNodeData {
  body: BaseNode[];
}

class ScopedStubNode extends BaseNode {
  private readonly body: BaseNode[];

  public constructor(data: ScopedStubNodeData) {
    super(data);
    this.body = data.body;
  }

  public override isScopedNode(): boolean {
    return true;
  }

  public override getScopeBody(): readonly BaseNode[] {
    return this.body;
  }

  public run(_options: NodeRunOptions): Promise<NodeRunResult> {
    return Promise.resolve({ status: 'completed', result: {} });
  }
}

describe('validateNodeIds', () => {
  describe('accepting structurally valid trees', () => {
    it('does not throw when the node list is empty', () => {
      expect(() => {
        validateNodeIds([]);
      }).not.toThrow();
    });

    it('does not throw when all node ids are distinct across nested scopes', () => {
      const leaf = new StubNode({ id: 'leaf' });
      const middle = new ScopedStubNode({ id: 'middle', body: [leaf] });
      const root = new ScopedStubNode({ id: 'root', body: [middle] });
      const sibling = new StubNode({ id: 'sibling' });

      expect(() => {
        validateNodeIds([root, sibling]);
      }).not.toThrow();
    });

    it('does not throw when a scoped node has an empty body', () => {
      const node = new ScopedStubNode({ id: 'container', body: [] });

      expect(() => {
        validateNodeIds([node]);
      }).not.toThrow();
    });

    it.each([...RESERVED_SCOPED_IDS])(
      'does not throw when a plain, non-scoped node uses the reserved id %s',
      (id) => {
        expect(() => {
          validateNodeIds([new StubNode({ id })]);
        }).not.toThrow();
      }
    );
  });

  describe('rejecting reserved words on scoped nodes', () => {
    it.each([...RESERVED_SCOPED_IDS])(
      'throws EngineConfigError naming the id when a scoped node uses the reserved word %s',
      (id) => {
        const node = new ScopedStubNode({ id, body: [new StubNode({ id: 'child' })] });

        let thrown: unknown;
        try {
          validateNodeIds([node]);
        } catch (e) {
          thrown = e;
        }

        expect(thrown).toBeInstanceOf(EngineConfigError);
        expect((thrown as Error).message).toContain(`Node '${id}' introduces a scope`);
      }
    );

    it('throws EngineConfigError when a scoped node uses a reserved word even though its scope body is empty', () => {
      const node = new ScopedStubNode({ id: 'loop', body: [] });

      expect(() => {
        validateNodeIds([node]);
      }).toThrow("Node 'loop' introduces a scope");
    });
  });

  describe('rejecting duplicate ids at every relation', () => {
    it('throws EngineConfigError naming the id when two root-level siblings share an id', () => {
      const nodes = [
        new StubNode({ id: 'unique' }),
        new StubNode({ id: 'dup' }),
        new StubNode({ id: 'dup' }),
      ];

      let thrown: unknown;
      try {
        validateNodeIds(nodes);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(EngineConfigError);
      expect((thrown as Error).message).toBe(
        "Duplicate node id: 'dup'; node ids must be unique across the entire workflow"
      );
    });

    it('throws EngineConfigError naming the id when a scoped node id matches a node directly in its own body', () => {
      const child = new StubNode({ id: 'dup' });
      const ancestor = new ScopedStubNode({ id: 'dup', body: [child] });

      let thrown: unknown;
      try {
        validateNodeIds([ancestor]);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(EngineConfigError);
      expect((thrown as Error).message).toContain("'dup'");
    });

    it('throws EngineConfigError naming the id when nodes in two unrelated sibling scopes share an id', () => {
      const nodeInA = new StubNode({ id: 'dup' });
      const scopeA = new ScopedStubNode({ id: 'scopeA', body: [nodeInA] });
      const nodeInB = new StubNode({ id: 'dup' });
      const scopeB = new ScopedStubNode({ id: 'scopeB', body: [nodeInB] });

      expect(() => {
        validateNodeIds([scopeA, scopeB]);
      }).toThrow("'dup'");
    });

    it('throws EngineConfigError naming the id when two siblings inside the same nested scope body share an id', () => {
      const siblingA = new StubNode({ id: 'dup' });
      const siblingB = new StubNode({ id: 'dup' });
      const node = new ScopedStubNode({ id: 'container', body: [siblingA, siblingB] });

      let thrown: unknown;
      try {
        validateNodeIds([node]);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(EngineConfigError);
      expect((thrown as Error).message).toContain("'dup'");
    });
  });
});

describe('validateDependencyReferences', () => {
  it('includes the referencing node id and missing dependency id in the error message', () => {
    const nodes = [new StubNode({ id: 'B', depends_on: ['ghost'] })];

    let thrown: unknown;
    try {
      validateDependencyReferences(nodes);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(EngineConfigError);
    expect((thrown as Error).message).toBe("Node 'B' has unknown depends_on reference: 'ghost'");
  });

  it('throws even when some dependencies are valid and one is not', () => {
    const nodes = [
      new StubNode({ id: 'A' }),
      new StubNode({ id: 'B', depends_on: ['A', 'missing'] }),
    ];

    expect(() => {
      validateDependencyReferences(nodes);
    }).toThrow("unknown depends_on reference: 'missing'");
  });

  it('does not throw when all dependency references are valid', () => {
    const nodes = [new StubNode({ id: 'A' }), new StubNode({ id: 'B', depends_on: ['A'] })];

    expect(() => {
      validateDependencyReferences(nodes);
    }).not.toThrow();
  });

  it('does not throw when nodes have no dependencies', () => {
    const nodes = [new StubNode({ id: 'X' }), new StubNode({ id: 'Y' })];

    expect(() => {
      validateDependencyReferences(nodes);
    }).not.toThrow();
  });
});

describe('validateSharedContextFanIn', () => {
  it('includes the consumer node id and both agentic predecessor ids in the error message', () => {
    const nodes = [
      new AgenticStubNode({ id: 'agent1' }),
      new AgenticStubNode({ id: 'agent2' }),
      new SharedContextNode({ id: 'consumer', depends_on: ['agent1', 'agent2'] }),
    ];

    let thrown: unknown;
    try {
      validateSharedContextFanIn(nodes);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(EngineConfigError);
    expect((thrown as Error).message).toBe(
      "Node 'consumer' with context:shared has multiple agentic predecessors: ['agent1', 'agent2']; at most one is allowed"
    );
  });

  it('does not throw when a shared-context node has exactly one agentic predecessor', () => {
    const nodes = [
      new AgenticStubNode({ id: 'agent1' }),
      new SharedContextNode({ id: 'consumer', depends_on: ['agent1'] }),
    ];

    expect(() => {
      validateSharedContextFanIn(nodes);
    }).not.toThrow();
  });

  it('does not throw when additional agentic nodes are only transitive predecessors', () => {
    const nodes = [
      new AgenticStubNode({ id: 'agent1' }),
      new AgenticStubNode({ id: 'agent2', depends_on: ['agent1'] }),
      new SharedContextNode({ id: 'consumer', depends_on: ['agent2'] }),
    ];

    expect(() => {
      validateSharedContextFanIn(nodes);
    }).not.toThrow();
  });

  it('throws when a shared-context node has two direct agentic predecessors even when they are also chained', () => {
    const nodes = [
      new AgenticStubNode({ id: 'agent1' }),
      new AgenticStubNode({ id: 'agent2', depends_on: ['agent1'] }),
      new SharedContextNode({ id: 'consumer', depends_on: ['agent1', 'agent2'] }),
    ];

    expect(() => {
      validateSharedContextFanIn(nodes);
    }).toThrow(
      "Node 'consumer' with context:shared has multiple agentic predecessors: ['agent1', 'agent2']; at most one is allowed"
    );
  });

  it('does not throw when a non-shared-context node has multiple agentic predecessors', () => {
    const nodes = [
      new AgenticStubNode({ id: 'agent1' }),
      new AgenticStubNode({ id: 'agent2' }),
      new StubNode({ id: 'collector', depends_on: ['agent1', 'agent2'] }),
    ];

    expect(() => {
      validateSharedContextFanIn(nodes);
    }).not.toThrow();
  });
});

describe('topologicalSort', () => {
  it('includes the cycle participant ids and message in the error', () => {
    const nodes = [
      new StubNode({ id: 'X', depends_on: ['Y'] }),
      new StubNode({ id: 'Y', depends_on: ['X'] }),
    ];

    let thrown: unknown;
    try {
      topologicalSort(nodes);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(EngineConfigError);
    expect((thrown as Error).message).toContain("'X'");
    expect((thrown as Error).message).toContain("'Y'");
  });

  it('throws for a three-node cycle', () => {
    const nodes = [
      new StubNode({ id: 'A', depends_on: ['C'] }),
      new StubNode({ id: 'B', depends_on: ['A'] }),
      new StubNode({ id: 'C', depends_on: ['B'] }),
    ];

    expect(() => topologicalSort(nodes)).toThrow('Cycle detected in workflow graph');
  });

  it('returns a topologically ordered array for a valid linear chain', () => {
    const nodeA = new StubNode({ id: 'A' });
    const nodeB = new StubNode({ id: 'B', depends_on: ['A'] });
    const nodeC = new StubNode({ id: 'C', depends_on: ['B'] });

    const result = topologicalSort([nodeA, nodeB, nodeC]);

    const ids = result.map((n) => n.id);
    expect(ids.indexOf('A')).toBeLessThan(ids.indexOf('B'));
    expect(ids.indexOf('B')).toBeLessThan(ids.indexOf('C'));
  });

  it('returns all input nodes when the graph is acyclic', () => {
    const nodes = [new StubNode({ id: 'X' }), new StubNode({ id: 'Y' }), new StubNode({ id: 'Z' })];

    const result = topologicalSort(nodes);

    expect(result).toHaveLength(3);
    expect(result.map((n) => n.id)).toEqual(expect.arrayContaining(['X', 'Y', 'Z']));
  });
});

describe('buildContextInheritanceMap', () => {
  it('returns an empty map when no shared-context nodes are present', () => {
    const nodes = [new StubNode({ id: 'A' }), new StubNode({ id: 'B', depends_on: ['A'] })];

    const result = buildContextInheritanceMap(nodes);

    expect(result.size).toBe(0);
  });

  it('returns the correct entry for a shared-context node with one agentic predecessor', () => {
    const writer = new AgenticStubNode({ id: 'writer' });
    const reader = new SharedContextNode({ id: 'reader', depends_on: ['writer'] });

    const result = buildContextInheritanceMap([writer, reader]);

    expect(result.get('reader')).toBe('writer');
  });

  it('does not include a shared-context node with zero agentic predecessors in the map', () => {
    const nodes = [
      new StubNode({ id: 'prep' }),
      new NonAgenticSharedContextNode({ id: 'consumer', depends_on: ['prep'] }),
    ];

    const result = buildContextInheritanceMap(nodes);

    expect(result.has('consumer')).toBe(false);
  });

  it('maps only the agentic predecessor when a shared-context node has one agentic and one non-agentic predecessor', () => {
    const nodes = [
      new AgenticStubNode({ id: 'agent' }),
      new StubNode({ id: 'helper' }),
      new SharedContextNode({ id: 'consumer', depends_on: ['agent', 'helper'] }),
    ];

    const result = buildContextInheritanceMap(nodes);

    expect(result.get('consumer')).toBe('agent');
  });

  it('returns entries for all shared-context nodes that have an agentic predecessor', () => {
    const nodes = [
      new AgenticStubNode({ id: 'agent1' }),
      new AgenticStubNode({ id: 'agent2' }),
      new SharedContextNode({ id: 'consumer1', depends_on: ['agent1'] }),
      new SharedContextNode({ id: 'consumer2', depends_on: ['agent2'] }),
    ];

    const result = buildContextInheritanceMap(nodes);

    expect(result.get('consumer1')).toBe('agent1');
    expect(result.get('consumer2')).toBe('agent2');
    expect(result.size).toBe(2);
  });

  it('maps the direct agentic predecessor when additional agentic nodes are only transitive', () => {
    const nodes = [
      new AgenticStubNode({ id: 'agent1' }),
      new AgenticStubNode({ id: 'agent2', depends_on: ['agent1'] }),
      new SharedContextNode({ id: 'consumer', depends_on: ['agent2'] }),
    ];

    const result = buildContextInheritanceMap(nodes);

    expect(result.get('consumer')).toBe('agent2');
  });
});

describe('validateNoNodeTypes', () => {
  it('does not throw when disallowedClasses is empty, even with nodes present', () => {
    const nodes = [new BreakLikeNode({ id: 'node-a' }), new ApprovalLikeNode({ id: 'node-b' })];

    expect(() => {
      validateNoNodeTypes(nodes, []);
    }).not.toThrow();
  });

  it('does not throw when nodes array is empty', () => {
    expect(() => {
      validateNoNodeTypes([], [BreakLikeNode, ApprovalLikeNode]);
    }).not.toThrow();
  });

  it('does not throw when no node is an instance of any disallowed class', () => {
    const nodes = [new StubNode({ id: 'step-1' }), new AgenticStubNode({ id: 'step-2' })];

    expect(() => {
      validateNoNodeTypes(nodes, [BreakLikeNode, ApprovalLikeNode]);
    }).not.toThrow();
  });

  it('includes the node id, matched class name, and disallowed class names in the error message when a node is disallowed', () => {
    const nodes = [new BreakLikeNode({ id: 'offending-node' })];

    expect(() => {
      validateNoNodeTypes(nodes, [BreakLikeNode]);
    }).toThrow(
      "Node 'offending-node' has type 'BreakLikeNode' which is not allowed here; disallowed types: ['BreakLikeNode']"
    );
  });

  it('throws when a node matches any class in a multi-entry disallowed list', () => {
    const nodes = [new ApprovalLikeNode({ id: 'gate-node' })];

    expect(() => {
      validateNoNodeTypes(nodes, [BreakLikeNode, ApprovalLikeNode]);
    }).toThrow(
      "Node 'gate-node' has type 'ApprovalLikeNode' which is not allowed here; disallowed types: ['BreakLikeNode', 'ApprovalLikeNode']"
    );
  });

  it('throws on the first matching node, not the last', () => {
    const nodes = [
      new StubNode({ id: 'allowed-1' }),
      new BreakLikeNode({ id: 'first-bad' }),
      new ApprovalLikeNode({ id: 'second-bad' }),
    ];

    expect(() => {
      validateNoNodeTypes(nodes, [BreakLikeNode, ApprovalLikeNode]);
    }).toThrow(
      "Node 'first-bad' has type 'BreakLikeNode' which is not allowed here; disallowed types: ['BreakLikeNode', 'ApprovalLikeNode']"
    );
  });

  it('throws when a node is an instance of a disallowed superclass, even if the subclass itself is not listed', () => {
    class BreakLikeSubNode extends BreakLikeNode {}
    const nodes = [new BreakLikeSubNode({ id: 'node-y' })];

    expect(() => {
      validateNoNodeTypes(nodes, [BreakLikeNode]);
    }).toThrow(
      "Node 'node-y' has type 'BreakLikeSubNode' which is not allowed here; disallowed types: ['BreakLikeNode']"
    );
  });
});
