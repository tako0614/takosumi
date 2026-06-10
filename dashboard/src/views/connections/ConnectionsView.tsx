import {
  createMemo,
  createResource,
  createSignal,
  For,
  Index,
  Match,
  Show,
  Switch,
} from "solid-js";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import {
  ApiError,
  type Connection,
  PROVIDERS,
  providerDescriptor,
  rpc,
} from "../account/lib/api.ts";
import { ActionError, createAction } from "../account/lib/action.tsx";
import {
  connectionScopeLabel,
  connectionStatusLabel,
} from "../../lib/status-labels.ts";
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";
import {
  type ControlApiError,
  createConnection as createControlConnection,
  isOAuthUnavailable,
  listConnections as listControlConnections,
  listOperatorConnectionDefaults,
  startCloudflareOAuth,
} from "../../lib/control-api.ts";
import SpaceSelector from "../control/SpaceSelector.tsx";
import { currentSpaceId } from "../control/space-state.ts";

/**
 * Sentinel `<select>` value for the generic Provider Env Set path. The
 * descriptor catalog (PROVIDERS) only ships guided providers (Cloudflare today);
 * picking this offers a plain "provider name + NAME=value env pairs" form that
 * posts the same `createControlConnection` shape, so any non-Cloudflare provider
 * is reachable from the UI instead of only via hand-crafted POST JSON. The
 * backend stores `provider !== "cloudflare"` submissions as a `provider_env_set`
 * Connection.
 */
const PROVIDER_ENV_SET_OPTION = "__provider_env_set__";

/** A single NAME=value row in the generic Provider Env Set editor. */
interface EnvPair {
  readonly name: string;
  readonly value: string;
}

/** Connection status badge — reuses the shared `.status-pill` styling. */
function ConnectionStatusPill(props: { status: Connection["status"] }) {
  return (
    <span class={`status-pill status-connection-${props.status}`}>
      {connectionStatusLabel(props.status)}
    </span>
  );
}

export default function ConnectionsView() {
  return <Page title="接続">{() => <ConnectionsInner />}</Page>;
}

function ConnectionsInner() {
  const { confirm } = useConfirmDialog();

  // Current Space comes from the shared header selector (space-state.ts), so the
  // space picked here matches the one picked on every other control view. No raw
  // id typing — the user picks one of their Spaces from the dropdown below.
  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);

  const [connections, { refetch }] = createResource(
    () => (spaceId() ? spaceId() : null),
    rpc.connections.list,
  );

  // Control-plane reads (spec §31): the per-Space Connection scope (operator vs
  // space) and the instance-wide operator default connections. Read-only here;
  // registration still flows through the account-plane RPC above.
  const [controlConnections] = createResource(
    () => (spaceId() ? spaceId() : null),
    listControlConnections,
  );
  const [operatorDefaults] = createResource(
    () => (spaceId() ? spaceId() : null),
    async (id) => (id ? await listOperatorConnectionDefaults(id) : []),
  );

  // connectionId -> scope, from the control listing, so each registered row can
  // show whether it is operator-default-backed or space-scoped.
  const scopeById = createMemo(() => {
    const map = new Map<string, string>();
    for (const c of controlConnections() ?? []) map.set(c.id, c.scope);
    return map;
  });

  const hasSpace = createMemo(() => !!spaceId());

  // ----- register form state -----------------------------------------------
  const [provider, setProvider] = createSignal(PROVIDERS[0]?.provider ?? "");
  const [displayName, setDisplayName] = createSignal("");
  // Field values are kept ONLY for the lifetime of the form. They are cleared
  // immediately after a successful submit (see clearForm) so secret material
  // never lingers in component state.
  const [values, setValues] = createSignal<Record<string, string>>({});
  // Guided-token paste field (the primary "<provider> に接続" path). Kept
  // separate from the advanced field map and cleared the moment it is consumed.
  const [helperToken, setHelperToken] = createSignal("");

  // Generic Provider Env Set editor state (the PROVIDER_ENV_SET_OPTION path):
  // a free-form provider name + NAME=value env pairs. Like `values`, these are
  // cleared on successful submit so secret material never lingers.
  const [envSetProvider, setEnvSetProvider] = createSignal("");
  const [envPairs, setEnvPairs] = createSignal<readonly EnvPair[]>([
    { name: "", value: "" },
  ]);
  const isEnvSet = () => provider() === PROVIDER_ENV_SET_OPTION;

  const descriptor = createMemo(() =>
    isEnvSet() ? undefined : providerDescriptor(provider()),
  );
  const fields = createMemo(() => descriptor()?.fields ?? []);
  const tokenHelper = createMemo(() => descriptor()?.tokenHelper);

  const setFieldValue = (envName: string, value: string) => {
    setValues((prev) => ({ ...prev, [envName]: value }));
  };

  const setEnvPair = (index: number, patch: Partial<EnvPair>) => {
    setEnvPairs((prev) =>
      prev.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    );
  };
  const addEnvPair = () =>
    setEnvPairs((prev) => [...prev, { name: "", value: "" }]);
  const removeEnvPair = (index: number) =>
    setEnvPairs((prev) =>
      prev.length > 1 ? prev.filter((_, i) => i !== index) : prev,
    );

  const clearForm = () => {
    setValues({});
    setHelperToken("");
    setDisplayName("");
    setEnvSetProvider("");
    setEnvPairs([{ name: "", value: "" }]);
  };

  // ----- one-time URL result banner (set by the OAuth backend callback) -----
  // The Cloudflare OAuth callback is a backend route that redirects here with
  // ?connected=1 or ?connection_error=<code>. We surface it, then strip the
  // query so a reload does not re-show it. No SPA route is added for this.
  const [oauthNotice, setOauthNotice] = createSignal<
    { kind: "ok" } | { kind: "error"; code: string } | null
  >(null);
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected")) setOauthNotice({ kind: "ok" });
    else {
      const err = params.get("connection_error");
      if (err) setOauthNotice({ kind: "error", code: err });
    }
    if (params.has("connected") || params.has("connection_error")) {
      params.delete("connected");
      params.delete("connection_error");
      const next = params.toString();
      window.history.replaceState(
        {},
        "",
        window.location.pathname + (next ? `?${next}` : ""),
      );
    }
  }

  // Primary guided-token submit: paste the provider-issued token, register a
  // Space-owned Connection through the session-authed control surface.
  const createFromHelper = createAction(async () => {
    const space = spaceId();
    if (!space) throw new Error("Space を選んでください。");
    const helper = tokenHelper();
    const d = descriptor();
    if (!helper || !d) throw new Error("provider が不正です。");
    const token = helperToken().trim();
    if (!token) throw new Error("トークンを貼り付けてください。");
    await createControlConnection({
      spaceId: space,
      provider: d.provider,
      displayName: displayName().trim() || undefined,
      values: { [helper.envName]: token },
    });
    // Clear the token from memory the moment the submit resolves.
    clearForm();
    await refetch();
  });

  // Advanced (raw field) submit — the "詳細設定" fallback for power users and
  // for providers without a guided helper.
  const create = createAction(async () => {
    const space = spaceId();
    if (!space) throw new Error("Space を選んでください。");
    const d = descriptor();
    if (!d) throw new Error("provider が不正です。");
    const submitValues: Record<string, string> = {};
    for (const field of d.fields) {
      const raw = (values()[field.envName] ?? "").trim();
      if (field.required && raw.length === 0) {
        throw new Error(`${field.label} は必須です。`);
      }
      if (raw.length > 0) submitValues[field.envName] = raw;
    }
    await createControlConnection({
      spaceId: space,
      provider: d.provider,
      displayName: displayName().trim() || undefined,
      values: submitValues,
    });
    // Clear secrets from memory the moment the submit resolves.
    clearForm();
    await refetch();
  });

  // Generic Provider Env Set submit — a free-form provider name plus NAME=value
  // env pairs. The backend stores a non-Cloudflare `provider` as a
  // `provider_env_set` Connection, so this is the UI for "any provider via
  // Provider Env Set" without hand-crafting POST JSON.
  const createEnvSet = createAction(async () => {
    const space = spaceId();
    if (!space) throw new Error("Space を選んでください。");
    const name = envSetProvider().trim();
    if (!name) throw new Error("プロバイダー名を入力してください。");
    if (name === "cloudflare") {
      throw new Error(
        "Cloudflare は上の Provider から登録してください（専用フローがあります）。",
      );
    }
    const submitValues: Record<string, string> = {};
    for (const pair of envPairs()) {
      const envName = pair.name.trim();
      const value = pair.value.trim();
      if (envName.length === 0 && value.length === 0) continue;
      if (envName.length === 0) {
        throw new Error("値のある行には環境変数名が必要です。");
      }
      submitValues[envName] = value;
    }
    if (Object.keys(submitValues).length === 0) {
      throw new Error("環境変数を 1 つ以上入力してください。");
    }
    await createControlConnection({
      spaceId: space,
      provider: name,
      displayName: displayName().trim() || undefined,
      values: submitValues,
    });
    // Clear secrets from memory the moment the submit resolves.
    clearForm();
    await refetch();
  });

  // ----- optional Cloudflare OAuth (operator-wired only) --------------------
  // We PROBE the backend before ever showing an OAuth button: the start route
  // is side-effect-free (it only signs state and returns an authorize URL), so
  // calling it tells us whether the operator wired the upstream client. A 501
  // (feature_unavailable) means "not configured" → we keep the button hidden,
  // so there is never a dead OAuth button. On success we keep the authorize URL
  // ready, and the button just navigates the browser to it.
  const oauthProbeKey = createMemo(() => {
    const space = spaceId();
    const d = descriptor();
    if (!space || !d?.oauthCandidate) return null;
    return { spaceId: space, provider: d.provider };
  });
  const [oauthProbe] = createResource(oauthProbeKey, async (key) => {
    try {
      const started = await startCloudflareOAuth({ spaceId: key.spaceId });
      return { authorizationUrl: started.authorizationUrl };
    } catch (e) {
      if (isOAuthUnavailable(e)) return { authorizationUrl: null };
      // Other errors (e.g. transient) also hide the button; the guided-token
      // path always remains available, so this never blocks the user.
      return { authorizationUrl: null };
    }
  });
  const oauthAvailable = createMemo(() => !!oauthProbe()?.authorizationUrl);

  const startOAuth = () => {
    const url = oauthProbe()?.authorizationUrl;
    if (!url) return;
    // Hand off to Cloudflare's own consent screen; the backend callback
    // redirects back to /connections with the result query.
    window.location.assign(url);
  };

  // Per-connection test action. Keyed display of the last result/error.
  const [testBusyId, setTestBusyId] = createSignal<string | null>(null);
  const [testError, setTestError] = createSignal<string | null>(null);

  const runTest = async (id: string) => {
    setTestBusyId(id);
    setTestError(null);
    try {
      await rpc.connections.test(id);
      await refetch();
    } catch (e) {
      setTestError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setTestBusyId(null);
    }
  };

  const remove = createAction(async (id: string) => {
    await rpc.connections.remove(id);
    await refetch();
  });

  const confirmRemove = async (c: Connection) => {
    const ok = await confirm({
      title: "接続を削除",
      message:
        `本当に ${c.displayName ?? c.id} を削除しますか？ ` +
        "保存された認証情報も削除され、 取り消せません。",
      confirmText: "削除",
      danger: true,
    });
    if (!ok) return;
    void remove.run(c.id);
  };

  return (
    <AppShell>
      <div class="page-header">
        <h1>接続</h1>
        <p class="page-sub">
          provider の認証情報を Space ごとに登録します。 値は書き込み専用で、
          一度保存すると再表示されません。
        </p>
      </div>

      {/* Result banner from the Cloudflare OAuth backend callback redirect. */}
      <Show when={oauthNotice()}>
        {(notice) => (
          <Switch>
            <Match when={notice().kind === "ok"}>
              <p class="sign-in-notice">Cloudflare に接続しました。</p>
            </Match>
            <Match when={notice().kind === "error"}>
              <p class="sign-in-error">
                接続に失敗しました。 もう一度お試しください。
              </p>
            </Match>
          </Switch>
        )}
      </Show>

      {/* Operator default connections (spec §9 / §31) — instance-wide defaults
          a ProviderBinding of `default` resolves to. Read-only here. */}
      <Show when={(operatorDefaults() ?? []).length > 0}>
        <section class="detail-section">
          <h2>オペレーター既定の接続</h2>
          <p class="page-sub">
            ProviderBinding が <code>default</code> のとき解決される、
            インスタンス全体の既定接続です。
          </p>
          <table class="data-table">
            <thead>
              <tr>
                <th>プロバイダー</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              <For each={operatorDefaults() ?? []}>
                {(d) => (
                  <tr>
                    <td>
                      <code>{d.provider}</code>
                    </td>
                    <td>設定済み</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </section>
      </Show>
      <Show when={operatorDefaults.error}>
        <p class="sign-in-error">
          オペレーター既定の取得に失敗しました —{" "}
          {(operatorDefaults.error as ControlApiError).message}
        </p>
      </Show>

      <SpaceSelector />

      <Show
        when={hasSpace()}
        fallback={
          <section class="empty-state">
            <p>Space を選ぶと接続一覧を表示します。</p>
          </section>
        }
      >
        {/* ----- register form ----- */}
        <section class="detail-section">
          <h2>接続を追加</h2>

          <label class="form-field">
            Provider
            <select
              value={provider()}
              onChange={(e) => {
                setProvider(e.currentTarget.value);
                // Switching provider drops any half-entered secret values.
                setValues({});
                setHelperToken("");
                setEnvSetProvider("");
                setEnvPairs([{ name: "", value: "" }]);
              }}
            >
              <For each={PROVIDERS}>
                {(p) => <option value={p.provider}>{p.label}</option>}
              </For>
              <option value={PROVIDER_ENV_SET_OPTION}>
                その他のプロバイダー（Provider Env Set）
              </option>
            </select>
          </label>

          <label class="form-field">
            表示名（任意）
            <input
              type="text"
              value={displayName()}
              onInput={(e) => setDisplayName(e.currentTarget.value)}
              placeholder="本番 Cloudflare"
              autocomplete="off"
            />
          </label>

          <Show
            when={isEnvSet()}
            fallback={
              <Show
                when={tokenHelper()}
                fallback={
                  /* No guided helper for this provider — raw fields are the path. */
                  <form
                    class="connection-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void create.run();
                    }}
                  >
                    <Index each={fields()}>
                      {(field) => (
                        <label class="form-field">
                          {field().label}
                          <Show when={field().required}>
                            <span class="form-required" aria-hidden="true">
                              *
                            </span>
                          </Show>
                          <input
                            type={field().secret ? "password" : "text"}
                            value={values()[field().envName] ?? ""}
                            onInput={(e) =>
                              setFieldValue(
                                field().envName,
                                e.currentTarget.value,
                              )
                            }
                            placeholder={field().placeholder}
                            autocomplete="off"
                            spellcheck={false}
                          />
                        </label>
                      )}
                    </Index>
                    <div class="form-actions">
                      <button
                        class="btn btn-primary"
                        type="submit"
                        disabled={create.busy()}
                      >
                        {create.busy() ? "登録中..." : "接続を登録"}
                      </button>
                    </div>
                    <ActionError error={create.error} />
                  </form>
                }
              >
                {(helper) => (
                  <>
                    {/* Primary guided-token flow: open the provider's OWN token
                    screen → create there → paste back. */}
                    <div class="connection-guided">
                      <p class="page-sub">
                        {descriptor()?.label} に接続します。 トークンは{" "}
                        {descriptor()?.label} の画面で作成し、
                        貼り付けるだけです。
                      </p>
                      <ol class="connection-steps">
                        <For each={helper().steps}>{(s) => <li>{s}</li>}</For>
                      </ol>

                      <div class="form-actions">
                        <a
                          class="btn btn-primary"
                          href={helper().createTokenUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {descriptor()?.label} を開いてトークンを作成
                        </a>
                        {/* OAuth button appears ONLY when the operator wired the
                        upstream client (probed). Otherwise it never renders, so
                        there is no dead button. */}
                        <Show when={oauthAvailable()}>
                          <button
                            class="btn btn-secondary"
                            type="button"
                            onClick={() => startOAuth()}
                          >
                            {descriptor()?.label} で自動接続
                          </button>
                        </Show>
                      </div>

                      <form
                        class="connection-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void createFromHelper.run();
                        }}
                      >
                        <label class="form-field">
                          作成したトークンを貼り付け
                          <span class="form-required" aria-hidden="true">
                            *
                          </span>
                          <input
                            type="password"
                            value={helperToken()}
                            onInput={(e) =>
                              setHelperToken(e.currentTarget.value)
                            }
                            placeholder="ここにトークンを貼り付け"
                            autocomplete="off"
                            spellcheck={false}
                          />
                        </label>
                        <div class="form-actions">
                          <button
                            class="btn btn-primary"
                            type="submit"
                            disabled={createFromHelper.busy()}
                          >
                            {createFromHelper.busy() ? "接続中..." : "接続する"}
                          </button>
                        </div>
                        <ActionError error={createFromHelper.error} />
                      </form>
                    </div>

                    {/* Advanced fallback: the raw multi-field form, demoted. */}
                    <details class="connection-advanced">
                      <summary>詳細設定（上級者向け）</summary>
                      <form
                        class="connection-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void create.run();
                        }}
                      >
                        <Index each={fields()}>
                          {(field) => (
                            <label class="form-field">
                              {field().label}
                              <Show when={field().required}>
                                <span class="form-required" aria-hidden="true">
                                  *
                                </span>
                              </Show>
                              <input
                                type={field().secret ? "password" : "text"}
                                value={values()[field().envName] ?? ""}
                                onInput={(e) =>
                                  setFieldValue(
                                    field().envName,
                                    e.currentTarget.value,
                                  )
                                }
                                placeholder={field().placeholder}
                                autocomplete="off"
                                spellcheck={false}
                              />
                            </label>
                          )}
                        </Index>
                        <div class="form-actions">
                          <button
                            class="btn btn-secondary"
                            type="submit"
                            disabled={create.busy()}
                          >
                            {create.busy() ? "登録中..." : "値を直接登録"}
                          </button>
                        </div>
                        <ActionError error={create.error} />
                      </form>
                    </details>
                  </>
                )}
              </Show>
            }
          >
            {/* Generic Provider Env Set: a free-form provider name + NAME=value
                env pairs. This makes "any provider via Provider Env Set"
                reachable from the UI; the backend stores a non-Cloudflare
                provider as a `provider_env_set` Connection. */}
            <div class="connection-guided">
              <p class="page-sub">
                AWS / GCP / Kubernetes など任意の OpenTofu provider
                の認証情報を、 環境変数 (NAME=value) として登録します。
                値は書き込み専用で、 保存後は env 名のみ表示されます。
              </p>

              <form
                class="connection-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void createEnvSet.run();
                }}
              >
                <label class="form-field">
                  プロバイダー名
                  <span class="form-required" aria-hidden="true">
                    *
                  </span>
                  <input
                    type="text"
                    value={envSetProvider()}
                    onInput={(e) => setEnvSetProvider(e.currentTarget.value)}
                    placeholder="aws / google / kubernetes / …"
                    autocomplete="off"
                    spellcheck={false}
                  />
                </label>

                <Index each={envPairs()}>
                  {(pair, index) => (
                    <div class="env-pair-row">
                      <label class="form-field">
                        環境変数名
                        <input
                          type="text"
                          value={pair().name}
                          onInput={(e) =>
                            setEnvPair(index, { name: e.currentTarget.value })
                          }
                          placeholder="AWS_ACCESS_KEY_ID"
                          autocomplete="off"
                          spellcheck={false}
                        />
                      </label>
                      <label class="form-field">
                        値
                        <input
                          type="password"
                          value={pair().value}
                          onInput={(e) =>
                            setEnvPair(index, { value: e.currentTarget.value })
                          }
                          placeholder="値を貼り付け"
                          autocomplete="off"
                          spellcheck={false}
                        />
                      </label>
                      <Show when={envPairs().length > 1}>
                        <button
                          class="btn btn-secondary"
                          type="button"
                          onClick={() => removeEnvPair(index)}
                        >
                          削除
                        </button>
                      </Show>
                    </div>
                  )}
                </Index>

                <div class="form-actions">
                  <button
                    class="btn btn-secondary"
                    type="button"
                    onClick={() => addEnvPair()}
                  >
                    環境変数を追加
                  </button>
                  <button
                    class="btn btn-primary"
                    type="submit"
                    disabled={createEnvSet.busy()}
                  >
                    {createEnvSet.busy() ? "登録中..." : "接続を登録"}
                  </button>
                </div>
                <ActionError error={createEnvSet.error} />
              </form>
            </div>
          </Show>
        </section>

        {/* ----- list ----- */}
        <Switch>
          <Match when={connections.loading}>
            <div class="grid-skel">
              <div class="skel-card" />
              <div class="skel-card" />
            </div>
          </Match>
          <Match when={connections.error}>
            <section class="empty-state error-state">
              <p>
                取得に失敗しました — {(connections.error as ApiError).message}
              </p>
            </section>
          </Match>
          <Match when={connections()}>
            {(list) => (
              <Show
                when={list().length > 0}
                fallback={
                  <section class="empty-state">
                    <p>この Space にはまだ接続がありません。</p>
                  </section>
                }
              >
                <section class="detail-section">
                  <h2>登録済みの接続</h2>
                  <ActionError error={remove.error} />
                  <Show when={testError()}>
                    {(m) => <p class="sign-in-error">{m()}</p>}
                  </Show>
                  <ul class="connection-list">
                    <For each={list()}>
                      {(c) => (
                        <li class="connection-row">
                          <div class="connection-row-main">
                            <span class="connection-name">
                              {c.displayName ?? c.id}
                            </span>
                            <ConnectionStatusPill status={c.status} />
                          </div>
                          <div class="connection-row-meta muted">
                            <span>{c.provider}</span>
                            <span>·</span>
                            <span class="connection-scope">
                              {connectionScopeLabel(
                                scopeById().get(c.id) ?? "space",
                              )}
                            </span>
                            <span>·</span>
                            <code>{c.envNames.join(", ")}</code>
                          </div>
                          <div class="connection-row-actions">
                            <button
                              class="btn btn-secondary"
                              type="button"
                              onClick={() => void runTest(c.id)}
                              disabled={testBusyId() === c.id}
                            >
                              {testBusyId() === c.id
                                ? "確認中..."
                                : "接続テスト"}
                            </button>
                            <button
                              class="btn btn-danger"
                              type="button"
                              onClick={() => void confirmRemove(c)}
                              disabled={remove.busy()}
                            >
                              削除
                            </button>
                          </div>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>
            )}
          </Match>
        </Switch>
      </Show>
    </AppShell>
  );
}
