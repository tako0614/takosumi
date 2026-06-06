/**
 * Pure topological layering for the §31 dependency-graph view.
 *
 * Kept in its own module (no SolidJS / JSX imports) so it can be unit-tested
 * directly and reused by the graph view without dragging in the AppShell/Page
 * chrome. A node sits one layer below its deepest producer (longest-path
 * layering); nodes in a cycle (which the backend forbids) are reported in
 * `cyclic` rather than hanging the loop.
 */
import type { GraphNode, SpaceGraph } from "../../lib/control-api.ts";

export interface LayeredGraph {
  readonly layers: readonly (readonly GraphNode[])[];
  /** Nodes left out of any layer (part of a cycle) — should be empty. */
  readonly cyclic: readonly GraphNode[];
  /** consumerId -> producer node names (for the "depends on" caption). */
  readonly producersByConsumer: ReadonlyMap<string, readonly string[]>;
}

export function layerGraph(graph: SpaceGraph): LayeredGraph {
  const nodeById = new Map(graph.nodes.map((n) => [n.installationId, n]));
  const producers = new Map<string, Set<string>>();
  const producersByConsumer = new Map<string, string[]>();
  for (const node of graph.nodes) producers.set(node.installationId, new Set());
  for (const edge of graph.edges) {
    producers.get(edge.consumerInstallationId)?.add(edge.producerInstallationId);
    const producerName = nodeById.get(edge.producerInstallationId)?.name ??
      edge.producerInstallationId;
    const list = producersByConsumer.get(edge.consumerInstallationId) ?? [];
    list.push(producerName);
    producersByConsumer.set(edge.consumerInstallationId, list);
  }

  const depth = new Map<string, number>();
  const resolved = new Set<string>();
  let progress = true;
  while (progress && resolved.size < graph.nodes.length) {
    progress = false;
    for (const node of graph.nodes) {
      const id = node.installationId;
      if (resolved.has(id)) continue;
      const deps = producers.get(id) ?? new Set<string>();
      let maxDepth = -1;
      let ready = true;
      for (const dep of deps) {
        if (!resolved.has(dep)) {
          ready = false;
          break;
        }
        maxDepth = Math.max(maxDepth, depth.get(dep) ?? 0);
      }
      if (ready) {
        depth.set(id, maxDepth + 1);
        resolved.add(id);
        progress = true;
      }
    }
  }

  const maxLayer = Math.max(0, ...[...depth.values()]);
  const layers: GraphNode[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const node of graph.nodes) {
    const d = depth.get(node.installationId);
    if (d !== undefined) layers[d]!.push(node);
  }
  const cyclic = graph.nodes.filter((n) => !resolved.has(n.installationId));
  return {
    layers: layers.filter((l) => l.length > 0),
    cyclic,
    producersByConsumer,
  };
}
