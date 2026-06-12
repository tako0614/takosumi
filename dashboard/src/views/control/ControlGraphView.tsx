/**
 * Graph view (spec §31) — the Space dependency DAG.
 *
 * Reads `GET /api/v1/spaces/:id/graph` ({nodes, edges}) and renders the DAG
 * structurally as topological LAYERS (producers above consumers): layer 0 is the
 * roots (no dependencies), each subsequent layer depends only on earlier ones.
 * Edges are listed under each consumer node ("depends on ..."). This is
 * dependency-free (no graph/d3/svg-layout libraries) per the dashboard's
 * keep-it-simple convention — a layered list communicates the DAG order without
 * a layout engine. A cycle (which the backend forbids) is surfaced as a
 * remaining-nodes block rather than hanging.
 */
import "../../styles/wave-b.css";
import { createMemo, createResource, For, Match, Show, Switch } from "solid-js";
import { Network } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import SpaceSelector from "./SpaceSelector.tsx";
import { currentSpaceId } from "./space-state.ts";
import {
  type ControlApiError,
  getSpaceGraph,
  type GraphNode,
} from "../../lib/control-api.ts";
import { layerGraph } from "./graph-layering.ts";
import { controlInstallationStatusLabel } from "../../lib/status-labels.ts";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
  type Tone,
} from "../../components/ui/index.ts";

export default function ControlGraphView() {
  return <Page title="依存グラフ">{() => <Inner />}</Page>;
}

function nodeTone(status: string): Tone {
  switch (status) {
    case "active":
      return "ok";
    case "error":
      return "danger";
    case "stale":
    case "pending":
      return "warn";
    case "disabled":
    case "destroyed":
      return "muted";
    default:
      return "neutral";
  }
}

function NodeBox(props: {
  node: GraphNode;
  producers: ReadonlyMap<string, readonly string[]>;
}) {
  const deps = () => props.producers.get(props.node.installationId) ?? [];
  return (
    <Card hover class="wb-graph-node">
      <div class="wb-graph-node-head">
        <span class="wb-graph-node-name">{props.node.name}</span>
        <Badge tone={nodeTone(props.node.status)}>
          {controlInstallationStatusLabel(props.node.status)}
        </Badge>
      </div>
      <Show when={deps().length > 0}>
        <div class="wb-graph-node-deps">↑ depends on {deps().join(", ")}</div>
      </Show>
    </Card>
  );
}

function Inner() {
  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);
  const [graph] = createResource(spaceId, getSpaceGraph);
  const layered = createMemo(() => {
    const g = graph();
    return g ? layerGraph(g) : undefined;
  });

  return (
    <AppShell>
      <PageHeader
        eyebrow="CONTROL"
        title="依存グラフ"
        subtitle="Installation の依存 DAG。 上の層が producer、 下の層が consumer です。"
        actions={
          <Button variant="secondary" href="/installations">
            一覧へ
          </Button>
        }
      />

      <SpaceSelector />

      <Show
        when={spaceId()}
        fallback={
          <EmptyState
            ink
            icon={<Network size={28} />}
            title="Space を選択"
            message="Space を選択すると依存グラフを表示します。"
          />
        }
      >
        <Switch>
          <Match when={graph.loading}>
            <Skeleton variant="card" count={2} />
          </Match>
          <Match when={graph.error}>
            <EmptyState
              icon={<Network size={28} />}
              title="取得に失敗しました"
              message={(graph.error as ControlApiError).message}
            />
          </Match>
          <Match when={layered()}>
            {(g) => (
              <Show
                when={g().layers.length > 0 || g().cyclic.length > 0}
                fallback={
                  <EmptyState
                    ink
                    icon={<Network size={28} />}
                    title="Installation がありません"
                    message="この Space にはまだ Installation がありません。"
                  />
                }
              >
                <section class="wb-graph">
                  <For each={g().layers}>
                    {(layer, i) => (
                      <div class="wb-graph-layer">
                        <div class="wb-graph-layer-label">
                          層 {i()}
                          <span class="wb-graph-layer-rule" aria-hidden="true" />
                        </div>
                        <div class="wb-graph-nodes">
                          <For each={layer}>
                            {(node) => (
                              <NodeBox
                                node={node}
                                producers={g().producersByConsumer}
                              />
                            )}
                          </For>
                        </div>
                      </div>
                    )}
                  </For>
                  <Show when={g().cyclic.length > 0}>
                    <div class="wb-graph-layer wb-graph-cyclic">
                      <div class="wb-graph-layer-label">
                        循環（解決不能）
                        <span class="wb-graph-layer-rule" aria-hidden="true" />
                      </div>
                      <div class="wb-graph-nodes">
                        <For each={g().cyclic}>
                          {(node) => (
                            <NodeBox
                              node={node}
                              producers={g().producersByConsumer}
                            />
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>
                </section>
              </Show>
            )}
          </Match>
        </Switch>
      </Show>
    </AppShell>
  );
}
