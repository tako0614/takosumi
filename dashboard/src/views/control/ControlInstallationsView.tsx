/**
 * Installations view (spec §31) — per-Space Installation list.
 *
 * For the current Space (space-state.ts), lists Installations via
 * `GET /v1/control/spaces/:id/installations` and the dependency DAG via
 * `GET /v1/control/spaces/:id/graph`, then renders each Installation with:
 *   - name / environment / status (with a `stale` badge),
 *   - depends-on (producer Installations from the graph edges), and
 *   - current generation + output-snapshot presence (MVP — the control routes
 *     do not yet expose projected output VALUES to the session surface, so we
 *     show the generation cursor + whether a snapshot exists rather than values).
 *
 * Each row links to the Plan summary flow via a "変更を確認" (plan) action that
 * creates a plan Run and navigates to the run view.
 */
import {
  createMemo,
  createResource,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import SpaceSelector from "./SpaceSelector.tsx";
import { currentSpaceId } from "./space-state.ts";
import {
  type ControlApiError,
  extractRunId,
  getSpaceGraph,
  type Installation,
  listInstallations,
  planInstallation,
  type SpaceGraph,
} from "../../lib/control-api.ts";
import { createAction } from "../account/lib/action.tsx";
import { controlInstallationStatusLabel } from "../../lib/status-labels.ts";

export default function ControlInstallationsView() {
  return <Page title="Installations">{() => <Inner />}</Page>;
}

/** Status pill mapping the control Installation enum to the shared pill styles. */
function StatusPill(props: { status: Installation["status"] }) {
  // Map the control status onto the existing `.status-*` modifier classes so we
  // reuse the same ready/installing/error colour treatment; `stale` gets the
  // installing (amber) treatment as "needs attention".
  const cls = createMemo(() => {
    switch (props.status) {
      case "active":
        return "status-ready";
      case "installing":
      case "destroying":
        return "status-installing";
      case "stale":
        return "status-installing";
      case "error":
        return "status-error";
      case "destroyed":
        return "status-suspended";
      default:
        return "";
    }
  });
  return (
    <span class={`status-pill ${cls()}`}>
      {controlInstallationStatusLabel(props.status)}
    </span>
  );
}

function Inner() {
  const navigate = useNavigate();
  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);

  const [installations] = createResource(spaceId, listInstallations);
  const [graph] = createResource(spaceId, getSpaceGraph);

  // Build: consumerInstallationId -> [producer node names], from the graph edges.
  const dependsOn = createMemo(() => {
    const g: SpaceGraph | undefined = graph();
    const map = new Map<string, string[]>();
    if (!g) return map;
    const nameById = new Map(g.nodes.map((n) => [n.installationId, n.name]));
    for (const edge of g.edges) {
      const producerName = nameById.get(edge.producerInstallationId) ??
        edge.producerInstallationId;
      const list = map.get(edge.consumerInstallationId) ?? [];
      list.push(producerName);
      map.set(edge.consumerInstallationId, list);
    }
    return map;
  });

  const plan = createAction(async (installationId: string) => {
    const envelope = await planInstallation(installationId);
    const runId = extractRunId(envelope);
    if (runId) navigate(`/runs/${runId}`);
  });

  return (
    <AppShell>
      <div class="page-header">
        <h1>Installations</h1>
        <p class="page-sub">
          Space 配下の Installation（OpenTofu root/state）を確認します。
        </p>
        <div class="page-actions">
          <a href="/install" class="btn btn-primary">+ Git から導入</a>
          <a href="/graph" class="btn btn-secondary">依存グラフ</a>
        </div>
      </div>

      <SpaceSelector />

      <Show
        when={spaceId()}
        fallback={
          <section class="empty-state">
            <p>Space を選択すると Installation 一覧を表示します。</p>
          </section>
        }
      >
        <Show when={plan.error()}>
          {(m) => <p class="sign-in-error">{m()}</p>}
        </Show>
        <Switch>
          <Match when={installations.loading}>
            <div class="grid-skel">
              <div class="skel-card" />
              <div class="skel-card" />
            </div>
          </Match>
          <Match when={installations.error}>
            <section class="empty-state error-state">
              <p>
                取得に失敗しました —{" "}
                {(installations.error as ControlApiError).message}
              </p>
            </section>
          </Match>
          <Match when={installations()}>
            {(list) => (
              <Show
                when={list().length > 0}
                fallback={
                  <section class="empty-state">
                    <p>この Space にはまだ Installation がありません。</p>
                    <a href="/install" class="btn btn-primary">
                      最初の Installation を導入 →
                    </a>
                  </section>
                }
              >
                <table class="data-table installations-table">
                  <thead>
                    <tr>
                      <th>名前</th>
                      <th>Environment</th>
                      <th>状態</th>
                      <th>依存</th>
                      <th>世代 / 出力</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    <For each={list()}>
                      {(inst) => (
                        <tr>
                          <td>
                            <span class="installation-name">{inst.name}</span>
                            <div class="muted installation-type">
                              {inst.installType} ·{" "}
                              <code class="installation-id">{inst.id}</code>
                            </div>
                          </td>
                          <td><code>{inst.environment}</code></td>
                          <td><StatusPill status={inst.status} /></td>
                          <td>
                            <Show
                              when={(dependsOn().get(inst.id) ?? []).length > 0}
                              fallback={<span class="muted">—</span>}
                            >
                              <ul class="depends-on-list">
                                <For each={dependsOn().get(inst.id) ?? []}>
                                  {(name) => <li><code>{name}</code></li>}
                                </For>
                              </ul>
                            </Show>
                          </td>
                          <td>
                            <span class="muted">gen</span>{" "}
                            {inst.currentStateGeneration}
                            <Show when={inst.currentOutputSnapshotId}>
                              <span class="output-badge" title="出力スナップショットあり">
                                outputs
                              </span>
                            </Show>
                          </td>
                          <td class="installation-row-actions">
                            <button
                              class="btn btn-secondary btn-sm"
                              type="button"
                              disabled={plan.busy()}
                              onClick={() => void plan.run(inst.id)}
                            >
                              変更を確認
                            </button>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
            )}
          </Match>
        </Switch>
      </Show>
    </AppShell>
  );
}
