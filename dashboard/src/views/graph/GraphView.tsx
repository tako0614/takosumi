/**
 * Graph view — the Space dependency DAG, rendered structurally as topological
 * LAYERS (producers above consumers) with no graph/d3 layout dependency. A
 * cycle (which the backend forbids) is surfaced as a remaining-nodes block
 * rather than hanging. Reached from the Capsule list and Workspace settings.
 */
import "../../styles/wave-b.css";
import { createMemo, createResource, For, Match, Show, Switch } from "solid-js";
import { Network } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import { currentSpaceId } from "../../lib/space-state.ts";
import {
  type ControlApiError,
  getSpaceGraph,
  type GraphNode,
} from "../../lib/control-api.ts";
import { layerGraph } from "./graph-layering.ts";
import { installationStatusLabel, installationTone } from "../../lib/labels.ts";
import { t } from "../../i18n/index.ts";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
} from "../../components/ui/index.ts";

export default function GraphView() {
  return <Page title={t("graph.title")}>{() => <Inner />}</Page>;
}

function NodeBox(props: {
  node: GraphNode;
  producers: ReadonlyMap<string, readonly string[]>;
}) {
  const deps = () => props.producers.get(props.node.installationId) ?? [];
  return (
    <Card hover class="wb-graph-node">
      <div class="wb-graph-node-head">
        <a
          class="wb-graph-node-name"
          href={`/capsules/${encodeURIComponent(props.node.installationId)}`}
        >
          {props.node.name}
        </a>
        <Badge tone={installationTone(props.node.status)}>
          {installationStatusLabel(props.node.status)}
        </Badge>
      </div>
      <Show when={deps().length > 0}>
        <div class="wb-graph-node-deps">
          {t("graph.dependsOn", { names: deps().join(", ") })}
        </div>
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
        title={t("graph.title")}
        subtitle={t("graph.subtitle")}
        actions={
          <Button variant="ghost" href="/">
            {t("app.backToList")}
          </Button>
        }
      />

      <Show
        when={spaceId()}
        fallback={
          <EmptyState
            ink
            icon={<Network size={28} />}
            title={t("space.select")}
            message={t("space.selectMessage")}
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
              title={t("graph.title")}
              message={t("common.fetchFailed", {
                message: (graph.error as ControlApiError).message,
              })}
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
                    title={t("graph.empty.title")}
                    message={t("graph.empty.message")}
                  />
                }
              >
                <section class="wb-graph">
                  <For each={g().layers}>
                    {(layer, i) => (
                      <div class="wb-graph-layer">
                        <div class="wb-graph-layer-label">
                          {t("graph.layer", { n: i() })}
                          <span
                            class="wb-graph-layer-rule"
                            aria-hidden="true"
                          />
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
                        {t("graph.cycle")}
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
