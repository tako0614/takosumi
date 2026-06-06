/**
 * takosumi-graph: Installation dependency DAG utilities (core-spec.md §14).
 *
 * Pure graph helpers over readonly producer -> consumer edges. The package is
 * deliberately free of service imports: it operates on plain node/edge data so
 * the deploy-control plane can use it for cycle prevention (Dependency
 * creation), topological ordering (RunGroup layering), and downstream-stale
 * closure (§24) without pulling in any service dependency.
 *
 * Edge orientation: `from` is the producer Installation, `to` is the consumer
 * Installation. An edge `{ from: a, to: b }` means "b depends on a", i.e. a
 * must be applied before b. A cycle is therefore a set of Installations that
 * mutually (transitively) depend on each other.
 */

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
}

/** Placeholder seam so the package has a stable import surface from M1. */
export const TAKOSUMI_GRAPH_PACKAGE = "takosumi-graph" as const;

/** Build a producer -> consumers adjacency map from the edge list. */
function buildAdjacency(edges: readonly GraphEdge[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    let consumers = adjacency.get(edge.from);
    if (consumers === undefined) {
      consumers = new Set<string>();
      adjacency.set(edge.from, consumers);
    }
    consumers.add(edge.to);
  }
  return adjacency;
}

/**
 * Detect a cycle in the dependency graph.
 *
 * When `candidate` is provided it is treated as an additional edge that does
 * not yet exist; the function answers "would adding this edge create a cycle?".
 * A self-edge (`from === to`) is always a cycle.
 *
 * Returns the cycle as an ordered path of node ids that starts and ends on the
 * same node (e.g. `["a", "b", "a"]`), or `undefined` when the graph (plus the
 * candidate) is acyclic.
 */
export function detectCycle(
  edges: readonly GraphEdge[],
  candidate?: GraphEdge,
): string[] | undefined {
  const allEdges = candidate === undefined ? edges : [...edges, candidate];

  // A self-edge is the smallest possible cycle.
  for (const edge of allEdges) {
    if (edge.from === edge.to) {
      return [edge.from, edge.to];
    }
  }

  const adjacency = buildAdjacency(allEdges);

  // Iterative DFS with explicit colouring so we can reconstruct the cycle path
  // deterministically without blowing the call stack on large graphs.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();

  // Deterministic node iteration order so the reported cycle is stable.
  const nodes = [...adjacency.keys()].sort((a, b) => a.localeCompare(b));

  for (const root of nodes) {
    if ((color.get(root) ?? WHITE) !== WHITE) {
      continue;
    }
    // Each frame remembers the consumers it still has to visit (sorted for
    // determinism) so we can detect back-edges and rebuild the path.
    const stack: { node: string; consumers: string[]; index: number }[] = [
      { node: root, consumers: sortedConsumers(adjacency, root), index: 0 },
    ];
    color.set(root, GRAY);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.index < frame.consumers.length) {
        const next = frame.consumers[frame.index];
        frame.index += 1;
        const nextColor = color.get(next) ?? WHITE;
        if (nextColor === GRAY) {
          // Back-edge: `next` is on the current DFS path. Reconstruct the cycle
          // from the point `next` first appeared on the stack.
          const path = stack.map((f) => f.node);
          const start = path.indexOf(next);
          return [...path.slice(start), next];
        }
        if (nextColor === WHITE) {
          color.set(next, GRAY);
          stack.push({
            node: next,
            consumers: sortedConsumers(adjacency, next),
            index: 0,
          });
        }
      } else {
        color.set(frame.node, BLACK);
        stack.pop();
      }
    }
  }

  return undefined;
}

function sortedConsumers(
  adjacency: Map<string, Set<string>>,
  node: string,
): string[] {
  const consumers = adjacency.get(node);
  if (consumers === undefined) {
    return [];
  }
  return [...consumers].sort((a, b) => a.localeCompare(b));
}

/**
 * Kahn layering: partition `nodes` into topological layers where every node in
 * a layer has all of its producers in earlier layers (producers before
 * consumers). Within a layer nodes are ordered deterministically by
 * `localeCompare`. Throws when the graph contains a cycle.
 *
 * Nodes referenced only by edges are included even if absent from `nodes`, so
 * the layering is well-defined over the full edge set.
 */
export function topologicalLayers(
  nodes: readonly string[],
  edges: readonly GraphEdge[],
): string[][] {
  const cycle = detectCycle(edges);
  if (cycle !== undefined) {
    throw new Error(
      `topologicalLayers: graph contains a cycle: ${cycle.join(" -> ")}`,
    );
  }

  const adjacency = buildAdjacency(edges);

  // Collect the full node universe: explicit nodes plus any node mentioned by
  // an edge endpoint.
  const universe = new Set<string>(nodes);
  for (const edge of edges) {
    universe.add(edge.from);
    universe.add(edge.to);
  }

  // In-degree = number of producers (edges pointing INTO the node).
  const indegree = new Map<string, number>();
  for (const node of universe) {
    indegree.set(node, 0);
  }
  for (const edge of edges) {
    // Only count edges whose endpoints are in the universe (they always are).
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const layers: string[][] = [];
  let frontier = [...universe]
    .filter((node) => (indegree.get(node) ?? 0) === 0)
    .sort((a, b) => a.localeCompare(b));
  let processed = 0;

  while (frontier.length > 0) {
    layers.push(frontier);
    processed += frontier.length;
    const nextFrontier: string[] = [];
    for (const node of frontier) {
      for (const consumer of sortedConsumers(adjacency, node)) {
        const remaining = (indegree.get(consumer) ?? 0) - 1;
        indegree.set(consumer, remaining);
        if (remaining === 0) {
          nextFrontier.push(consumer);
        }
      }
    }
    frontier = nextFrontier.sort((a, b) => a.localeCompare(b));
  }

  if (processed !== universe.size) {
    // Should be unreachable because detectCycle already ran, but guard anyway.
    throw new Error("topologicalLayers: graph contains a cycle");
  }

  return layers;
}

/**
 * Transitive downstream closure: every consumer reachable from `start` by
 * following producer -> consumer edges, NOT including `start` itself.
 *
 * Used for the §24 stale cascade: when an Installation's outputs change, all of
 * its transitive downstream consumers become candidates for `stale`.
 */
export function downstreamClosure(
  edges: readonly GraphEdge[],
  start: string,
): Set<string> {
  const adjacency = buildAdjacency(edges);
  const closure = new Set<string>();
  const stack: string[] = [start];

  while (stack.length > 0) {
    const node = stack.pop() as string;
    const consumers = adjacency.get(node);
    if (consumers === undefined) {
      continue;
    }
    for (const consumer of consumers) {
      if (consumer === start) {
        // Skip start even if a cycle (defensively) points back at it.
        continue;
      }
      if (!closure.has(consumer)) {
        closure.add(consumer);
        stack.push(consumer);
      }
    }
  }

  return closure;
}
