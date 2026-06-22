/**
 * Unit tests for the §31 dependency-graph layering + the run-id extractor.
 * Pure logic only (no DOM / SolidJS), runnable under `bun test`.
 */
import { describe, expect, test } from "bun:test";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";
import { layerGraph } from "../../../../../dashboard/src/views/graph/graph-layering.ts";
import { extractRunId } from "../../../../../dashboard/src/lib/control-api.ts";
import type {
  GraphEdge,
  GraphNode,
  InstallationStatus,
  SpaceGraph,
} from "../../../../../dashboard/src/lib/control-api.ts";

function node(id: string, name = id): GraphNode {
  return {
    installationId: id,
    name,
    environment: "production",
    status: "active" as InstallationStatus,
  };
}

function edge(producer: string, consumer: string): GraphEdge {
  return {
    id: `dep_${producer}_${consumer}`,
    producerInstallationId: producer,
    consumerInstallationId: consumer,
    outputs: {},
  };
}

function ids(nodes: readonly GraphNode[]): string[] {
  return nodes.map((n) => n.installationId).sort();
}

describe("layerGraph", () => {
  test("roots with no edges land on layer 0", () => {
    const graph: SpaceGraph = { nodes: [node("a"), node("b")], edges: [] };
    const result = layerGraph(graph);
    expect(result.layers.length).toEqual(1);
    expect(ids(result.layers[0]!)).toEqual(["a", "b"]);
    expect(result.cyclic).toEqual([]);
  });

  test("a depends-on chain lays out in producer->consumer order", () => {
    // core <- gateway <- talk : core layer 0, gateway 1, talk 2.
    const graph: SpaceGraph = {
      nodes: [node("talk"), node("gateway"), node("core")],
      edges: [edge("core", "gateway"), edge("gateway", "talk")],
    };
    const result = layerGraph(graph);
    expect(result.layers.length).toEqual(3);
    expect(ids(result.layers[0]!)).toEqual(["core"]);
    expect(ids(result.layers[1]!)).toEqual(["gateway"]);
    expect(ids(result.layers[2]!)).toEqual(["talk"]);
  });

  test("a node sits one layer below its DEEPEST producer (diamond)", () => {
    //   core(0) -> a(1), core(0) -> b(1), a+b -> sink
    // sink depends on a(1) and b(1) so sink is layer 2.
    const graph: SpaceGraph = {
      nodes: [node("core"), node("a"), node("b"), node("sink")],
      edges: [
        edge("core", "a"),
        edge("core", "b"),
        edge("a", "sink"),
        edge("b", "sink"),
      ],
    };
    const result = layerGraph(graph);
    expect(ids(result.layers[0]!)).toEqual(["core"]);
    expect(ids(result.layers[1]!)).toEqual(["a", "b"]);
    expect(ids(result.layers[2]!)).toEqual(["sink"]);
  });

  test("producersByConsumer maps consumer -> producer names", () => {
    const graph: SpaceGraph = {
      nodes: [node("core", "Core"), node("talk", "Talk")],
      edges: [edge("core", "talk")],
    };
    const result = layerGraph(graph);
    expect(result.producersByConsumer.get("talk")).toEqual(["Core"]);
    expect(result.producersByConsumer.get("core")).toBeUndefined();
  });

  test("a cycle is reported in `cyclic` rather than hanging", () => {
    const graph: SpaceGraph = {
      nodes: [node("x"), node("y")],
      edges: [edge("x", "y"), edge("y", "x")],
    };
    const result = layerGraph(graph);
    expect(result.layers).toEqual([]);
    expect(ids(result.cyclic)).toEqual(["x", "y"]);
  });
});

describe("extractRunId", () => {
  test("reads a plan envelope ({ planRun: { id } })", () => {
    expect(extractRunId({ planRun: { id: "run_plan" } })).toEqual("run_plan");
  });

  test("reads a source-sync envelope ({ run: { id } })", () => {
    expect(extractRunId({ run: { id: "ssr_1" } })).toEqual("ssr_1");
  });

  test("reads a bare { id } envelope", () => {
    expect(extractRunId({ id: "run_bare" })).toEqual("run_bare");
  });

  test("returns undefined for an unrecognized shape", () => {
    expect(extractRunId({})).toBeUndefined();
    expect(extractRunId(null)).toBeUndefined();
    expect(extractRunId("nope")).toBeUndefined();
  });
});

describe("graph view copy", () => {
  test("uses dependency wording instead of graph theory or setup-order jargon", () => {
    expect(en["graph.title"]).toBe("Dependencies");
    expect(en["graph.layer"]).toBe("Group {n}");
    expect(en["graph.cycle"]).toBe("Needs review");
    expect(en["graph.dependsOn"]).toBe("Uses {names}");
    expect(ja["graph.title"]).toBe("依存関係");
    expect(ja["graph.layer"]).toBe("グループ {n}");
    expect(ja["graph.cycle"]).toBe("確認が必要");
    expect(ja["graph.dependsOn"]).toBe("{names} を利用");
  });
});
