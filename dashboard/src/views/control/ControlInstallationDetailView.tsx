import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { useNavigate, useParams } from "@solidjs/router";
import { Archive } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import StatusPill from "../account/components/StatusPill.tsx";
import {
  type BackupRecord,
  type ControlApiError,
  type ProviderBinding,
  type ProviderBindingMode,
  type ProviderBindings,
  createInstallationBackup,
  destroyPlanInstallation,
  extractRunId,
  getDeploymentProfile,
  getInstallation,
  getSpaceGraph,
  listConnections,
  listInstallConfigs,
  listOperatorConnectionDefaults,
  listSources,
  planInstallation,
  putDeploymentProfile,
} from "../../lib/control-api.ts";
import { createAction } from "../account/lib/action.tsx";
import {
  controlInstallationStatusClass,
  controlInstallationStatusLabel,
} from "../../lib/status-labels.ts";

export default function ControlInstallationDetailView() {
  return <Page title="Installation">{() => <Inner />}</Page>;
}

function Inner() {
  const params = useParams();
  const navigate = useNavigate();
  const installationId = () => params.id ?? "";

  const [installation, { refetch: refetchInstallation }] = createResource(
    installationId,
    getInstallation,
  );
  const spaceId = () => installation()?.spaceId;
  const [profile, { refetch: refetchProfile }] = createResource(
    installationId,
    getDeploymentProfile,
  );
  const [sources] = createResource(spaceId, listSources);
  const [configs] = createResource(spaceId, listInstallConfigs);
  const [graph] = createResource(spaceId, getSpaceGraph);
  const [connections] = createResource(spaceId, listConnections);
  const [operatorDefaults] = createResource(spaceId, async (id) =>
    id ? await listOperatorConnectionDefaults(id) : [],
  );

  const [bindingRows, setBindingRows] = createSignal<ProviderBindingRow[]>([]);
  const [formError, setFormError] = createSignal<string | null>(null);

  createEffect(() => {
    const bindings = profile()?.bindings;
    if (!bindings) return;
    setBindingRows(bindings.map(providerBindingToRow));
  });

  const source = createMemo(() =>
    (sources() ?? []).find((item) => item.id === installation()?.sourceId),
  );
  const installConfig = createMemo(() =>
    (configs() ?? []).find(
      (item) => item.id === installation()?.installConfigId,
    ),
  );
  const producers = createMemo(() => {
    const inst = installation();
    const g = graph();
    if (!inst || !g) return [];
    const names = new Map(
      g.nodes.map((node) => [node.installationId, node.name]),
    );
    return g.edges
      .filter((edge) => edge.consumerInstallationId === inst.id)
      .map((edge) => ({
        id: edge.id,
        producerInstallationId: edge.producerInstallationId,
        name:
          names.get(edge.producerInstallationId) ?? edge.producerInstallationId,
        outputs: Object.values(edge.outputs),
      }));
  });
  const consumers = createMemo(() => {
    const inst = installation();
    const g = graph();
    if (!inst || !g) return [];
    const names = new Map(
      g.nodes.map((node) => [node.installationId, node.name]),
    );
    return g.edges
      .filter((edge) => edge.producerInstallationId === inst.id)
      .map((edge) => ({
        id: edge.id,
        consumerInstallationId: edge.consumerInstallationId,
        name:
          names.get(edge.consumerInstallationId) ?? edge.consumerInstallationId,
        outputs: Object.values(edge.outputs),
      }));
  });
  const defaultByProvider = createMemo(() => {
    const map = new Map<string, string>();
    for (const item of operatorDefaults() ?? []) {
      map.set(item.provider, item.provider);
    }
    return map;
  });

  const plan = createAction(async () => {
    const envelope = await planInstallation(installationId());
    const runId = extractRunId(envelope);
    if (runId) navigate(`/runs/${runId}`);
  });
  const destroyPlan = createAction(async () => {
    const envelope = await destroyPlanInstallation(installationId());
    const runId = extractRunId(envelope);
    if (runId) navigate(`/runs/${runId}`);
  });
  const backup = createAction(async (): Promise<BackupRecord> => {
    return await createInstallationBackup(installationId());
  });
  const saveProfile = createAction(async () => {
    setFormError(null);
    const bindings = buildBindings(bindingRows());
    if ("error" in bindings) {
      setFormError(bindings.error);
      return;
    }
    await putDeploymentProfile(installationId(), bindings.bindings);
    await Promise.all([refetchProfile(), refetchInstallation()]);
  });

  return (
    <AppShell>
      <div class="page-header">
        <h1>Installation</h1>
        <p class="page-sub">
          Capsule + generated root + tfstate 単位の詳細と binding を確認します。
        </p>
        <div class="page-actions">
          <a href="/installations" class="btn btn-secondary">
            一覧へ
          </a>
          <button
            class="btn btn-secondary"
            type="button"
            disabled={backup.busy()}
            onClick={() => void backup.run()}
          >
            <Archive size={16} />
            Backup
          </button>
          <button
            class="btn btn-primary"
            type="button"
            disabled={plan.busy()}
            onClick={() => void plan.run()}
          >
            Plan
          </button>
          <button
            class="btn btn-danger"
            type="button"
            disabled={destroyPlan.busy()}
            onClick={() => void destroyPlan.run()}
          >
            Destroy plan
          </button>
        </div>
      </div>

      <Switch>
        <Match when={installation.loading}>
          <div class="grid-skel">
            <div class="skel-block tall" />
          </div>
        </Match>
        <Match when={installation.error}>
          <section class="empty-state error-state">
            <p>
              取得に失敗しました —{" "}
              {(installation.error as ControlApiError).message}
            </p>
          </section>
        </Match>
        <Match when={installation()}>
          {(inst) => (
            <>
              <Show when={plan.error()}>
                {(m) => <p class="sign-in-error">{m()}</p>}
              </Show>
              <Show when={destroyPlan.error()}>
                {(m) => <p class="sign-in-error">{m()}</p>}
              </Show>
              <Show when={backup.error()}>
                {(m) => <p class="sign-in-error">{m()}</p>}
              </Show>
              <Show when={backup.result()}>
                {(record) => (
                  <p class="muted backup-progress">
                    Backup created: <code>{record().id}</code>
                  </p>
                )}
              </Show>

              <section class="detail-section">
                <h2>
                  {inst().name}
                  <StatusPill
                    class={controlInstallationStatusClass(inst().status)}
                  >
                    {controlInstallationStatusLabel(inst().status)}
                  </StatusPill>
                </h2>
                <dl class="kv-list">
                  <dt>ID</dt>
                  <dd>
                    <code>{inst().id}</code>
                  </dd>
                  <dt>State generation</dt>
                  <dd>{inst().currentStateGeneration}</dd>
                  <dt>Output snapshot</dt>
                  <dd>
                    <Show
                      when={inst().currentOutputSnapshotId}
                      fallback={<span class="muted">none</span>}
                    >
                      {(id) => <code>{id()}</code>}
                    </Show>
                  </dd>
                  <dt>InstallConfig</dt>
                  <dd>
                    <Show
                      when={installConfig()}
                      fallback={<code>{inst().installConfigId}</code>}
                    >
                      {(config) => (
                        <>
                          {config().name} · <code>{config().trustLevel}</code>
                        </>
                      )}
                    </Show>
                  </dd>
                </dl>
              </section>

              <section class="detail-section">
                <h2>Source</h2>
                <Show
                  when={source()}
                  fallback={<p class="muted">Source 情報を読み込み中です。</p>}
                >
                  {(src) => (
                    <dl class="kv-list">
                      <dt>Name</dt>
                      <dd>{src().name}</dd>
                      <dt>Git URL</dt>
                      <dd>
                        <code>{src().url}</code>
                      </dd>
                      <dt>Ref / Path</dt>
                      <dd>
                        <code>{src().defaultRef}</code>
                        <span class="muted"> / </span>
                        <code>{src().defaultPath}</code>
                      </dd>
                      <dt>Status</dt>
                      <dd>{src().status}</dd>
                    </dl>
                  )}
                </Show>
              </section>

              <section class="detail-section">
                <h2>Dependencies</h2>
                <div class="dependency-columns">
                  <DependencyList title="Depends on" rows={producers()} />
                  <DependencyList title="Used by" rows={consumers()} />
                </div>
              </section>

              <section class="detail-section">
                <h2>Provider bindings</h2>
                <form
                  class="install-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveProfile.run();
                  }}
                >
                  <div class="capability-grid">
                    <For each={bindingRows()}>
                      {(row, index) => (
                        <div class="capability-row">
                          <div class="capability-head">
                            <input
                              value={row.provider}
                              onInput={(e) =>
                                updateProviderBindingRow(
                                  setBindingRows,
                                  index(),
                                  { provider: e.currentTarget.value },
                                )
                              }
                              placeholder="registry.opentofu.org/cloudflare/cloudflare"
                            />
                            <input
                              value={row.alias}
                              onInput={(e) =>
                                updateProviderBindingRow(
                                  setBindingRows,
                                  index(),
                                  { alias: e.currentTarget.value },
                                )
                              }
                              placeholder="alias (optional)"
                            />
                            <Show
                              when={defaultByProvider().get(row.provider)}
                              fallback={
                                <span class="muted">default 未設定</span>
                              }
                            >
                              {(provider) => (
                                <span class="muted">default: {provider()}</span>
                              )}
                            </Show>
                          </div>
                          <div class="capability-controls">
                            <select
                              value={row.mode}
                              onChange={(e) =>
                                updateProviderBindingRow(
                                  setBindingRows,
                                  index(),
                                  {
                                    mode: e.currentTarget
                                      .value as ProviderBindingMode,
                                  },
                                )
                              }
                            >
                              <option value="default">default</option>
                              <option value="connection">connection</option>
                              <option value="manual">manual</option>
                              <option value="disabled">disabled</option>
                            </select>
                            <Show
                              when={row.mode === "connection"}
                            >
                              <select
                                value={row.connectionId}
                                onChange={(e) =>
                                  updateProviderBindingRow(
                                    setBindingRows,
                                    index(),
                                    { connectionId: e.currentTarget.value },
                                  )
                                }
                              >
                                <option value="">接続を選択</option>
                                <For each={connections() ?? []}>
                                  {(connection) => (
                                    <option value={connection.id}>
                                      {connection.displayName ??
                                        connection.provider}{" "}
                                      — {connection.status}
                                    </option>
                                  )}
                                </For>
                              </select>
                            </Show>
                            <Show when={row.mode === "manual"}>
                              <textarea
                                rows={3}
                                value={row.manualValues}
                                onInput={(e) =>
                                  updateProviderBindingRow(
                                    setBindingRows,
                                    index(),
                                    { manualValues: e.currentTarget.value },
                                  )
                                }
                                placeholder='{"name":"value"}'
                                spellcheck={false}
                              />
                            </Show>
                            <button
                              class="btn btn-secondary"
                              type="button"
                              onClick={() =>
                                setBindingRows((prev) =>
                                  prev.filter((_, i) => i !== index()),
                                )
                              }
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                  <div class="form-actions">
                    <button
                      class="btn btn-secondary"
                      type="button"
                      onClick={() =>
                        setBindingRows((prev) => [
                          ...prev,
                          {
                            provider: "",
                            alias: "",
                            mode: "default",
                            connectionId: "",
                            manualValues: "",
                          },
                        ])
                      }
                    >
                      Add provider
                    </button>
                    <button
                      class="btn btn-primary"
                      type="submit"
                      disabled={saveProfile.busy()}
                    >
                      {saveProfile.busy() ? "保存中..." : "保存"}
                    </button>
                  </div>
                  <Show when={formError()}>
                    {(m) => <p class="sign-in-error">{m()}</p>}
                  </Show>
                  <Show when={saveProfile.error()}>
                    {(m) => <p class="sign-in-error">{m()}</p>}
                  </Show>
                </form>
              </section>
            </>
          )}
        </Match>
      </Switch>
    </AppShell>
  );
}

function DependencyList(props: {
  readonly title: string;
  readonly rows: readonly {
    readonly id: string;
    readonly name: string;
    readonly outputs: readonly { readonly from: string; readonly to: string }[];
  }[];
}) {
  return (
    <div>
      <h3>{props.title}</h3>
      <Show when={props.rows.length > 0} fallback={<p class="muted">none</p>}>
        <ul class="depends-on-list">
          <For each={props.rows}>
            {(row) => (
              <li>
                <code>{row.name}</code>
                <Show when={row.outputs.length > 0}>
                  <span class="muted">
                    {" "}
                    {row.outputs
                      .map((output) => `${output.from}→${output.to}`)
                      .join(", ")}
                  </span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

interface ProviderBindingRow {
  readonly provider: string;
  readonly alias: string;
  readonly mode: ProviderBindingMode;
  readonly connectionId: string;
  readonly manualValues: string;
}

function providerBindingToRow(binding: ProviderBinding): ProviderBindingRow {
  return {
    provider: binding.provider,
    alias: binding.alias ?? "",
    mode: binding.mode,
    connectionId: binding.connectionId ?? "",
    manualValues: binding.values
      ? JSON.stringify(binding.values, null, 2)
      : "",
  };
}

function updateProviderBindingRow(
  setRows: (updater: (rows: ProviderBindingRow[]) => ProviderBindingRow[]) =>
    void,
  index: number,
  patch: Partial<ProviderBindingRow>,
): void {
  setRows((rows) =>
    rows.map((row, i) => i === index ? { ...row, ...patch } : row),
  );
}

function buildBindings(
  rows: readonly ProviderBindingRow[],
): { readonly bindings: ProviderBindings } | { readonly error: string } {
  const bindings: ProviderBinding[] = [];
  for (const [index, row] of rows.entries()) {
    const provider = row.provider.trim();
    if (!provider) {
      return { error: `Provider binding ${index + 1} の provider を入力してください。` };
    }
    const mode = row.mode ?? "default";
    const binding: {
      provider: string;
      alias?: string;
      mode: ProviderBindingMode;
      connectionId?: string;
      values?: Record<string, unknown>;
    } = { provider, mode };
    const alias = row.alias.trim();
    if (alias) binding.alias = alias;
    if (mode === "connection") {
      const connectionId = row.connectionId.trim();
      if (!connectionId) {
        return { error: `${provider} の Connection を選択してください。` };
      }
      binding.connectionId = connectionId;
    }
    if (mode === "manual") {
      const text = row.manualValues.trim();
      if (!text) {
        return { error: `${provider} の manual value を入力してください。` };
      }
      let values: unknown;
      try {
        values = JSON.parse(text);
      } catch {
        return { error: `${provider} の manual value は JSON object です。` };
      }
      if (
        typeof values !== "object" ||
        values === null ||
        Array.isArray(values)
      ) {
        return { error: `${provider} の manual value は JSON object です。` };
      }
      binding.values = values as Record<string, unknown>;
    }
    bindings.push(binding);
  }
  return { bindings };
}
