import { EngineConfigError } from './errors.ts';
import type { BaseNode } from './nodes/base.ts';

export const validateDependencyReferences = (nodes: BaseNode[]): void => {
  const knownIds = new Set(nodes.map((n) => n.id));

  for (const node of nodes) {
    for (const dep of node.getDependencies()) {
      if (!knownIds.has(dep)) {
        throw new EngineConfigError(`Node '${node.id}' has unknown depends_on reference: '${dep}'`);
      }
    }
  }
};

export const validateSharedContextFanIn = (nodes: BaseNode[]): void => {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  for (const node of nodes) {
    if (!node.useSharedContext()) {
      continue;
    }

    const agenticPredecessors = node
      .getDependencies()
      .filter((depId) => nodeById.get(depId)?.isAgentic() === true);

    if (agenticPredecessors.length > 1) {
      throw new EngineConfigError(
        `Node '${node.id}' with context:shared has multiple agentic predecessors: [${agenticPredecessors.map((id) => `'${id}'`).join(', ')}]; at most one is allowed`
      );
    }
  }
};

export const validateNoNodeTypes = (
  nodes: BaseNode[],
  disallowedClasses: readonly (abstract new (...args: never[]) => BaseNode)[]
): void => {
  const unique = [...new Set(disallowedClasses)];
  for (const node of nodes) {
    if (unique.some((cls) => node instanceof cls)) {
      throw new EngineConfigError(
        `Node '${node.id}' has type '${node.constructor.name}' which is not allowed here; disallowed types: [${unique.map((cls) => `'${cls.name}'`).join(', ')}]`
      );
    }
  }
};

export const topologicalSort = (nodes: BaseNode[]): BaseNode[] => {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  const nodeById = new Map<string, BaseNode>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
    nodeById.set(node.id, node);
  }

  for (const node of nodes) {
    for (const dep of node.getDependencies()) {
      adjacency.get(dep)!.push(node.id);
      inDegree.set(node.id, inDegree.get(node.id)! + 1);
    }
  }

  // Kahn's algorithm. `head` advances rather than shifting elements out of
  // `queue` to keep the overall sort at O(V+E); Array.shift() is O(n) per call.
  const queue: string[] = [];
  let head = 0;
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  const order: string[] = [];
  while (head < queue.length) {
    const id = queue[head++]!;
    order.push(id);

    for (const successor of adjacency.get(id)!) {
      const newDegree = inDegree.get(successor)! - 1;
      inDegree.set(successor, newDegree);
      if (newDegree === 0) {
        queue.push(successor);
      }
    }
  }

  if (order.length !== nodes.length) {
    const orderedSet = new Set(order);
    const remaining = nodes.filter((n) => !orderedSet.has(n.id)).map((n) => n.id);
    throw new EngineConfigError(
      `Cycle detected in workflow graph involving nodes: [${remaining.map((id) => `'${id}'`).join(', ')}]`
    );
  }

  return order.map((id) => nodeById.get(id)!);
};

export const buildSharedContextMap = (orderedNodes: BaseNode[]): Map<string, string> => {
  const nodeById = new Map(orderedNodes.map((n) => [n.id, n]));
  const sharedContextMap = new Map<string, string>();

  for (const node of orderedNodes) {
    if (!node.useSharedContext()) {
      continue;
    }

    const agenticPredecessor = node
      .getDependencies()
      .find((depId) => nodeById.get(depId)?.isAgentic() === true);

    if (agenticPredecessor !== undefined) {
      sharedContextMap.set(node.id, agenticPredecessor);
    }
  }

  return sharedContextMap;
};
