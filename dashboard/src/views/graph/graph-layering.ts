/**
 * Pure topological layering for the §31 dependency-graph view.
 *
 * Kept in its own module (no SolidJS / JSX imports) so it can be unit-tested
 * directly and reused by the graph view without dragging in the AppShell/Page
 * chrome. A node sits one layer below its deepest producer (longest-path
 * layering); nodes in a cycle (which the backend forbids) are reported in
 * `cyclic` rather than hanging the loop.
 */
import type { GraphNode, WorkspaceGraph } from "../../lib/control-api.ts";

export interface LayeredGraph {
  readonly layers: readonly (readonly GraphNode[])[];
  /** Nodes left out of any layer (part of a cycle) — should be empty. */
  readonly cyclic: readonly GraphNode[];
  /** consumerId -> producer node names (for the "depends on" caption). */
  readonly producersByConsumer: ReadonlyMap<string, readonly string[]>;
}

/**
 * Node filter for the dependencies view: destroyed Capsules are noise in a
 * "who uses whose values" screen, so they are dropped — unless they still
 * participate in a dependency edge (a live service still points at them, which
 * is exactly what this view must surface).
 */
export function filterGraphForDependencyView(
  graph: WorkspaceGraph,
): WorkspaceGraph {
  const inEdge = new Set<string>();
  for (const edge of graph.edges) {
    inEdge.add(edge.producerCapsuleId);
    inEdge.add(edge.consumerCapsuleId);
  }
  return {
    ...graph,
    nodes: graph.nodes.filter(
      (node) => node.status !== "destroyed" || inEdge.has(node.capsuleId),
    ),
  };
}

export function layerGraph(graph: WorkspaceGraph): LayeredGraph {
  const nodeById = new Map<string, GraphNode>();
  const producers = new Map<string, Set<string>>();
  const consumers = new Map<string, Set<string>>();
  const producerNamesByConsumer = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    const id = node.capsuleId;
    nodeById.set(id, node);
    if (!producers.has(id)) {
      producers.set(id, new Set());
    }
  }
  for (const edge of graph.edges) {
    const dependencies = producers.get(edge.consumerCapsuleId);
    if (dependencies && !dependencies.has(edge.producerCapsuleId)) {
      dependencies.add(edge.producerCapsuleId);
      const downstream = consumers.get(edge.producerCapsuleId) ?? new Set();
      downstream.add(edge.consumerCapsuleId);
      consumers.set(edge.producerCapsuleId, downstream);
    }
    const producerName =
      nodeById.get(edge.producerCapsuleId)?.name ?? edge.producerCapsuleId;
    // Multiple output→input wirings between the same pair are one dependency in
    // the caption — don't list the same producer name more than once.
    const names =
      producerNamesByConsumer.get(edge.consumerCapsuleId) ?? new Set<string>();
    names.add(producerName);
    producerNamesByConsumer.set(edge.consumerCapsuleId, names);
  }

  const remainingProducers = new Map<string, number>();
  for (const [id, dependencies] of producers) {
    remainingProducers.set(id, dependencies.size);
  }
  const deepestProducer = new Map<string, number>();
  const depth = new Map<string, number>();
  const resolved = new Set<string>();
  const queued = new Set<string>();
  const queue: string[] = [];
  for (const node of graph.nodes) {
    const id = node.capsuleId;
    if (remainingProducers.get(id) === 0 && !queued.has(id)) {
      queued.add(id);
      depth.set(id, 0);
      queue.push(id);
    }
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor]!;
    resolved.add(id);
    const currentDepth = depth.get(id) ?? 0;
    const downstream = consumers.get(id);
    if (!downstream) continue;
    for (const consumerId of downstream) {
      const remaining = remainingProducers.get(consumerId);
      if (remaining === undefined || remaining === 0) continue;
      const nextRemaining = remaining - 1;
      remainingProducers.set(consumerId, nextRemaining);
      deepestProducer.set(
        consumerId,
        Math.max(deepestProducer.get(consumerId) ?? -1, currentDepth),
      );
      if (nextRemaining === 0 && !queued.has(consumerId)) {
        queued.add(consumerId);
        depth.set(consumerId, (deepestProducer.get(consumerId) ?? -1) + 1);
        queue.push(consumerId);
      }
    }
  }

  let maxLayer = 0;
  for (const value of depth.values()) maxLayer = Math.max(maxLayer, value);
  const layers: GraphNode[][] = Array.from({ length: maxLayer + 1 }, () => []);
  const cyclic: GraphNode[] = [];
  for (const node of graph.nodes) {
    const id = node.capsuleId;
    if (!resolved.has(id)) {
      cyclic.push(node);
      continue;
    }
    const d = depth.get(id);
    if (d !== undefined) layers[d]!.push(node);
  }
  const producersByConsumer = new Map<string, readonly string[]>();
  for (const [consumerId, names] of producerNamesByConsumer) {
    producersByConsumer.set(consumerId, [...names]);
  }
  return {
    layers: layers.filter((l) => l.length > 0),
    cyclic,
    producersByConsumer,
  };
}
