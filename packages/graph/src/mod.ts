/**
 * takosumi-graph: Installation dependency DAG utilities (core-spec.md §14).
 *
 * M1 skeleton — topological sort and cycle detection land with the
 * Dependency DAG milestone (conformance M6). Keep this package free of
 * service imports: it operates on plain node/edge data.
 */

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
}

/** Placeholder seam so the package has a stable import surface from M1. */
export const TAKOSUMI_GRAPH_PACKAGE = "takosumi-graph" as const;
