/**
 * Graph view (spec §31) — the Space dependency DAG.
 *
 * Reads `GET /v1/control/spaces/:id/graph` ({nodes, edges}) and renders the DAG
 * structurally as topological LAYERS (producers above consumers): layer 0 is the
 * roots (no dependencies), each subsequent layer depends only on earlier ones.
 * Edges are listed under each consumer node ("depends on ..."). This is
 * dependency-free (no graph/d3/svg-layout libraries) per the dashboard's
 * keep-it-simple convention — a layered list communicates the DAG order without
 * a layout engine. A cycle (which the backend forbids) is surfaced as a
 * remaining-nodes block rather than hanging.
 */
import { createMemo, createResource, For, Match, Show, Switch } from "solid-js";
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

export default function ControlGraphView() {
  return <Page title="依存グラフ">{() => <Inner />}</Page>;
}

function NodeBox(props: {
  node: GraphNode;
  producers: ReadonlyMap<string, readonly string[]>;
}) {
  const deps = () => props.producers.get(props.node.installationId) ?? [];
  return (
    <div class="graph-node">
      <div class="graph-node-head">
        <span class="graph-node-name">{props.node.name}</span>
        <span
          class={`graph-node-status graph-node-status-${props.node.status}`}
        >
          {controlInstallationStatusLabel(props.node.status)}
        </span>
      </div>
      <Show when={deps().length > 0}>
        <div class="graph-node-deps muted">
          ↑ depends on {deps().join(", ")}
        </div>
      </Show>
    </div>
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
      <div class="page-header">
        <h1>依存グラフ</h1>
        <p class="page-sub">
          Installation の依存 DAG。 上の層が producer、 下の層が consumer です。
        </p>
        <div class="page-actions">
          <a href="/installations" class="btn btn-secondary">
            一覧へ
          </a>
        </div>
      </div>

      <SpaceSelector />

      <Show
        when={spaceId()}
        fallback={
          <section class="empty-state">
            <p>Space を選択すると依存グラフを表示します。</p>
          </section>
        }
      >
        <Switch>
          <Match when={graph.loading}>
            <div class="grid-skel">
              <div class="skel-card" />
              <div class="skel-card" />
            </div>
          </Match>
          <Match when={graph.error}>
            <section class="empty-state error-state">
              <p>
                取得に失敗しました — {(graph.error as ControlApiError).message}
              </p>
            </section>
          </Match>
          <Match when={layered()}>
            {(g) => (
              <Show
                when={g().layers.length > 0 || g().cyclic.length > 0}
                fallback={
                  <section class="empty-state">
                    <p>この Space にはまだ Installation がありません。</p>
                  </section>
                }
              >
                <section class="graph-board">
                  <For each={g().layers}>
                    {(layer, i) => (
                      <div class="graph-layer">
                        <div class="graph-layer-label muted">層 {i()}</div>
                        <div class="graph-layer-nodes">
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
                    <div class="graph-layer">
                      <div class="graph-layer-label muted">
                        循環（解決不能）
                      </div>
                      <div class="graph-layer-nodes">
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
