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
import StatusPill from "../account/components/StatusPill.tsx";
import SpaceSelector from "./SpaceSelector.tsx";
import { currentSpaceId } from "./space-state.ts";
import {
  type ControlApiError,
  extractRunId,
  listConnections,
  listSources,
  syncSource,
} from "../../lib/control-api.ts";
import { createAction } from "../account/lib/action.tsx";

export default function ControlSourcesView() {
  return <Page title="Sources">{() => <Inner />}</Page>;
}

function Inner() {
  const navigate = useNavigate();
  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);
  const [sources, { refetch }] = createResource(spaceId, listSources);
  const [connections] = createResource(spaceId, listConnections);

  const connectionName = createMemo(() => {
    const map = new Map<string, string>();
    for (const c of connections() ?? []) {
      map.set(c.id, c.displayName ?? c.provider ?? c.id);
    }
    return map;
  });

  const sync = createAction(async (sourceId: string) => {
    const envelope = await syncSource(sourceId);
    await refetch();
    const runId = extractRunId(envelope);
    if (runId) navigate(`/runs/${runId}`);
  });

  return (
    <AppShell>
      <div class="page-header">
        <h1>Sources</h1>
        <p class="page-sub">
          Space に登録された Git Source と、SourceSnapshot 同期を管理します。
        </p>
        <div class="page-actions">
          <a href="/install" class="btn btn-primary">+ Git から導入</a>
        </div>
      </div>

      <SpaceSelector />

      <Show
        when={spaceId()}
        fallback={
          <section class="empty-state">
            <p>Space を選択すると Source 一覧を表示します。</p>
          </section>
        }
      >
        <Show when={sync.error()}>
          {(m) => <p class="sign-in-error">{m()}</p>}
        </Show>
        <Switch>
          <Match when={sources.loading}>
            <div class="grid-skel">
              <div class="skel-card" />
              <div class="skel-card" />
            </div>
          </Match>
          <Match when={sources.error}>
            <section class="empty-state error-state">
              <p>取得に失敗しました — {(sources.error as ControlApiError).message}</p>
            </section>
          </Match>
          <Match when={sources()}>
            {(list) => (
              <Show
                when={list().length > 0}
                fallback={
                  <section class="empty-state">
                    <p>この Space にはまだ Source がありません。</p>
                    <a href="/install" class="btn btn-primary">
                      Git から導入
                    </a>
                  </section>
                }
              >
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>名前</th>
                      <th>Git</th>
                      <th>Ref / Path</th>
                      <th>Auth</th>
                      <th>状態</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    <For each={list()}>
                      {(source) => (
                        <tr>
                          <td>
                            <strong>{source.name}</strong>
                            <div class="muted installation-type">
                              <code>{source.id}</code>
                            </div>
                          </td>
                          <td class="source-url-cell">
                            <code>{source.url}</code>
                          </td>
                          <td>
                            <code>{source.defaultRef}</code>
                            <span class="muted"> / </span>
                            <code>{source.defaultPath}</code>
                          </td>
                          <td>
                            <Show
                              when={source.authConnectionId}
                              fallback={<span class="muted">none</span>}
                            >
                              {(id) => (
                                <span>
                                  {connectionName().get(id()) ?? id()}
                                  <div class="muted installation-type">
                                    <code>{id()}</code>
                                  </div>
                                </span>
                              )}
                            </Show>
                          </td>
                          <td>
                            <StatusPill
                              class={source.status === "active"
                                ? "status-ready"
                                : source.status === "error"
                                ? "status-error"
                                : "status-suspended"}
                            >
                              {source.status}
                            </StatusPill>
                          </td>
                          <td class="installation-row-actions">
                            <button
                              class="btn btn-secondary btn-sm"
                              type="button"
                              disabled={sync.busy()}
                              onClick={() => void sync.run(source.id)}
                            >
                              同期
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
