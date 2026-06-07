/**
 * RunGroup summary view (spec §31) — a Space-update RunGroup.
 *
 * A RunGroup orders multiple Runs across the dependency DAG (e.g. a Space update
 * after stale propagation). This view reads `GET /v1/control/run-groups/:id`
 * ({runGroup, runs}), shows the group status + ordered member list, and offers
 * "全て承認" (`POST /v1/control/run-groups/:id/approve`) to approve the group.
 */
import { createMemo, createResource, For, Match, Show, Switch } from "solid-js";
import { useParams } from "@solidjs/router";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import StatusPill from "../account/components/StatusPill.tsx";
import {
  approveRunGroup,
  type ControlApiError,
  getRunGroup,
} from "../../lib/control-api.ts";
import { createAction } from "../account/lib/action.tsx";
import {
  controlRunStatusClass,
  controlRunStatusLabel,
} from "../../lib/status-labels.ts";

export default function ControlRunGroupView() {
  return <Page title="Space 更新">{() => <Inner />}</Page>;
}

function Inner() {
  const params = useParams();
  const groupId = () => params.id ?? "";

  const [group, { refetch }] = createResource(groupId, getRunGroup);

  const anyWaiting = createMemo(() =>
    (group()?.runs ?? []).some((r) => r.status === "waiting_approval")
  );

  const approveAll = createAction(async () => {
    await approveRunGroup(groupId());
    await refetch();
  });

  return (
    <AppShell>
      <div class="page-header">
        <h1>Space 更新（RunGroup）</h1>
        <p class="page-sub">
          DAG 順に並んだ複数 Run のグループ。 まとめて承認できます。
        </p>
        <div class="page-actions">
          <a href="/installations" class="btn btn-secondary">一覧へ</a>
        </div>
      </div>

      <Switch>
        <Match when={group.loading}>
          <div class="grid-skel"><div class="skel-block tall" /></div>
        </Match>
        <Match when={group.error}>
          <section class="empty-state error-state">
            <p>取得に失敗しました — {(group.error as ControlApiError).message}</p>
          </section>
        </Match>
        <Match when={group()}>
          {(g) => (
            <section class="detail-section">
              <h2>
                RunGroup
                <Show when={g().runGroup.status}>
                  <span class="status-pill">
                    {controlRunStatusLabel(g().runGroup.status)}
                  </span>
                </Show>
              </h2>
              <dl class="kv-list">
                <dt>Group ID</dt>
                <dd><code>{g().runGroup.id}</code></dd>
                <Show when={g().runGroup.type}>
                  <dt>種別</dt>
                  <dd><code>{g().runGroup.type}</code></dd>
                </Show>
              </dl>

              <Show when={anyWaiting()}>
                <div class="form-actions run-approve">
                  <button
                    class="btn btn-primary"
                    type="button"
                    disabled={approveAll.busy()}
                    onClick={() => void approveAll.run()}
                  >
                    {approveAll.busy() ? "承認中..." : "全ての Run を承認"}
                  </button>
                </div>
              </Show>
              <Show when={approveAll.error()}>
                {(m) => <p class="sign-in-error">{m()}</p>}
              </Show>

              <h2 class="run-members-heading">メンバー Run</h2>
              <Show
                when={g().runs.length > 0}
                fallback={<p class="muted">メンバー Run はありません。</p>}
              >
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>種別</th>
                      <th>状態</th>
                      <th>Installation</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={g().runs}>
                      {(r) => (
                        <tr>
                          <td>
                            <a href={`/runs/${r.id}`}><code>{r.id}</code></a>
                          </td>
                          <td><code>{r.type}</code></td>
                          <td>
                            <StatusPill class={controlRunStatusClass(r.status)}>
                              {controlRunStatusLabel(r.status)}
                            </StatusPill>
                          </td>
                          <td>
                            <Show
                              when={r.installationId}
                              fallback={<span class="muted">—</span>}
                            >
                              <code>{r.installationId}</code>
                            </Show>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
            </section>
          )}
        </Match>
      </Switch>
    </AppShell>
  );
}
