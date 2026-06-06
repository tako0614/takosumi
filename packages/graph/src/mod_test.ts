import { describe, expect, test } from "bun:test";
import {
  type GraphEdge,
  detectCycle,
  downstreamClosure,
  topologicalLayers,
} from "./mod.ts";

const edge = (from: string, to: string): GraphEdge => ({ from, to });

describe("detectCycle", () => {
  test("acyclic graph returns undefined", () => {
    const edges = [edge("a", "b"), edge("b", "c"), edge("a", "c")];
    expect(detectCycle(edges)).toBeUndefined();
  });

  test("empty graph returns undefined", () => {
    expect(detectCycle([])).toBeUndefined();
  });

  test("direct two-node cycle is detected", () => {
    const edges = [edge("a", "b"), edge("b", "a")];
    const cycle = detectCycle(edges);
    expect(cycle).toBeDefined();
    // path starts and ends on the same node
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1] ?? "");
    expect(new Set(cycle)).toEqual(new Set(["a", "b"]));
  });

  test("longer transitive cycle is detected", () => {
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "a")];
    const cycle = detectCycle(edges);
    expect(cycle).toBeDefined();
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1] ?? "");
    expect(new Set(cycle)).toEqual(new Set(["a", "b", "c"]));
  });

  test("self-edge is a cycle", () => {
    const cycle = detectCycle([edge("a", "a")]);
    expect(cycle).toEqual(["a", "a"]);
  });

  test("self-edge candidate is rejected", () => {
    const cycle = detectCycle([edge("a", "b")], edge("c", "c"));
    expect(cycle).toEqual(["c", "c"]);
  });

  test("candidate that closes a cycle is detected", () => {
    // existing: a -> b -> c (acyclic); candidate c -> a closes it.
    const edges = [edge("a", "b"), edge("b", "c")];
    expect(detectCycle(edges)).toBeUndefined();
    const cycle = detectCycle(edges, edge("c", "a"));
    expect(cycle).toBeDefined();
    expect(new Set(cycle)).toEqual(new Set(["a", "b", "c"]));
  });

  test("candidate that stays acyclic returns undefined", () => {
    const edges = [edge("a", "b"), edge("b", "c")];
    expect(detectCycle(edges, edge("a", "c"))).toBeUndefined();
  });

  test("reported cycle is deterministic across equivalent edge orderings", () => {
    const a = [edge("a", "b"), edge("b", "c"), edge("c", "a")];
    const b = [edge("c", "a"), edge("a", "b"), edge("b", "c")];
    expect(detectCycle(a)).toEqual(detectCycle(b));
  });
});

describe("topologicalLayers", () => {
  test("linear chain layers each node alone in producer order", () => {
    const edges = [edge("a", "b"), edge("b", "c")];
    expect(topologicalLayers(["a", "b", "c"], edges)).toEqual([
      ["a"],
      ["b"],
      ["c"],
    ]);
  });

  test("diamond produces producer-before-consumer layers", () => {
    // a -> b, a -> c, b -> d, c -> d
    const edges = [
      edge("a", "b"),
      edge("a", "c"),
      edge("b", "d"),
      edge("c", "d"),
    ];
    expect(topologicalLayers(["a", "b", "c", "d"], edges)).toEqual([
      ["a"],
      ["b", "c"],
      ["d"],
    ]);
  });

  test("within-layer ordering is deterministic by localeCompare", () => {
    // roots with no producers must come out sorted, regardless of node input order.
    const edges = [edge("z", "y")];
    expect(topologicalLayers(["m", "z", "a"], edges)).toEqual([
      ["a", "m", "z"],
      ["y"],
    ]);
  });

  test("disconnected components share layers by indegree", () => {
    // component 1: a -> b ; component 2: c (isolated) ; component 3: d -> e
    const edges = [edge("a", "b"), edge("d", "e")];
    expect(topologicalLayers(["a", "b", "c", "d", "e"], edges)).toEqual([
      ["a", "c", "d"],
      ["b", "e"],
    ]);
  });

  test("nodes referenced only by edges are included", () => {
    // "b" not listed in nodes but appears as an edge endpoint.
    const edges = [edge("a", "b")];
    expect(topologicalLayers(["a"], edges)).toEqual([["a"], ["b"]]);
  });

  test("isolated nodes with no edges form a single sorted layer", () => {
    expect(topologicalLayers(["c", "a", "b"], [])).toEqual([["a", "b", "c"]]);
  });

  test("throws on a cycle", () => {
    const edges = [edge("a", "b"), edge("b", "a")];
    expect(() => topologicalLayers(["a", "b"], edges)).toThrow(/cycle/);
  });

  test("layering is stable across equivalent edge orderings", () => {
    const nodes = ["a", "b", "c", "d"];
    const a = [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")];
    const b = [edge("c", "d"), edge("b", "d"), edge("a", "c"), edge("a", "b")];
    expect(topologicalLayers(nodes, a)).toEqual(topologicalLayers(nodes, b));
  });
});

describe("downstreamClosure", () => {
  test("linear chain returns all transitive consumers", () => {
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d")];
    expect(downstreamClosure(edges, "a")).toEqual(new Set(["b", "c", "d"]));
  });

  test("does not include the start node", () => {
    const edges = [edge("a", "b"), edge("b", "c")];
    const closure = downstreamClosure(edges, "a");
    expect(closure.has("a")).toBe(false);
  });

  test("diamond closure covers both branches once", () => {
    const edges = [
      edge("a", "b"),
      edge("a", "c"),
      edge("b", "d"),
      edge("c", "d"),
    ];
    expect(downstreamClosure(edges, "a")).toEqual(new Set(["b", "c", "d"]));
  });

  test("partial closure from a mid node", () => {
    const edges = [
      edge("a", "b"),
      edge("a", "c"),
      edge("b", "d"),
      edge("c", "d"),
    ];
    // from "b" only "d" is downstream; "c" is a sibling, not a consumer of b.
    expect(downstreamClosure(edges, "b")).toEqual(new Set(["d"]));
  });

  test("leaf node has empty closure", () => {
    const edges = [edge("a", "b")];
    expect(downstreamClosure(edges, "b")).toEqual(new Set());
  });

  test("disconnected node not reached by start is excluded", () => {
    const edges = [edge("a", "b"), edge("x", "y")];
    expect(downstreamClosure(edges, "a")).toEqual(new Set(["b"]));
  });

  test("cycle does not loop forever and excludes start", () => {
    // defensive: even a cyclic input must terminate and never re-add start.
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "a")];
    const closure = downstreamClosure(edges, "a");
    expect(closure.has("a")).toBe(false);
    expect(closure).toEqual(new Set(["b", "c"]));
  });
});
