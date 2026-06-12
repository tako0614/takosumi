import "../../styles/wave-c.css";
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
import { Link, Plug, Plus, Trash } from "lucide-solid";
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
import {
  Badge,
  Button,
  Card,
  CardHeader,
  type Column,
  DataTable,
  EmptyState,
  FormField,
  Input,
  PageHeader,
  Select,
  Skeleton,
  StatusBadge,
  Toast,
  type Tone,
} from "../../components/ui/index.ts";

/** Maps a Connection status to a Badge tone for the StatusBadge. */
function connectionStatusTone(status: string | undefined): Tone {
  switch (status) {
    case "verified":
      return "ok";
    case "pending":
      return "warn";
    case "error":
      return "danger";
    case "revoked":
    case "expired":
      return "muted";
    default:
      return "neutral";
  }
}

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

/** Connection status badge — token-driven StatusBadge. */
function ConnectionStatusPill(props: { status: Connection["status"] }) {
  return (
    <StatusBadge
      status={props.status}
      label={connectionStatusLabel}
      tone={connectionStatusTone}
    />
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

  const operatorColumns: readonly Column<{ provider: string }>[] = [
    { header: "プロバイダー", cell: (d) => <code class="wc-code">{d.provider}</code> },
    { header: "状態", cell: () => <Badge tone="ok">設定済み</Badge> },
  ];

  return (
    <AppShell>
      <PageHeader
        eyebrow="Connection"
        title="接続"
        subtitle="provider の認証情報を Space ごとに登録します。値は書き込み専用で、一度保存すると再表示されません。"
      />

      {/* Result banner from the Cloudflare OAuth backend callback redirect. */}
      <Show when={oauthNotice()}>
        {(notice) => (
          <Switch>
            <Match when={notice().kind === "ok"}>
              <Toast tone="success">Cloudflare に接続しました。</Toast>
            </Match>
            <Match when={notice().kind === "error"}>
              <Toast tone="error">
                接続に失敗しました。もう一度お試しください。
              </Toast>
            </Match>
          </Switch>
        )}
      </Show>

      <div class="wc-stack">
        {/* Operator default connections (spec §9 / §31) — instance-wide defaults
            a ProviderBinding of `default` resolves to. Read-only here. */}
        <Show when={(operatorDefaults() ?? []).length > 0}>
          <Card>
            <CardHeader
              title="オペレーター既定の接続"
              subtitle="ProviderBinding が default のとき解決される、インスタンス全体の既定接続です。"
            />
            <DataTable
              columns={operatorColumns}
              rows={operatorDefaults() ?? []}
              rowKey={(d) => d.provider}
            />
          </Card>
        </Show>
        <Show when={operatorDefaults.error}>
          <Toast tone="error">
            オペレーター既定の取得に失敗しました —{" "}
            {(operatorDefaults.error as ControlApiError).message}
          </Toast>
        </Show>

        <SpaceSelector />

        <Show
          when={hasSpace()}
          fallback={
            <EmptyState
              ink
              icon={<Plug size={26} />}
              title="Space を選択"
              message="Space を選ぶと接続一覧を表示します。"
            />
          }
        >
          {/* ----- register form ----- */}
          <Card>
            <CardHeader
              title="接続を追加"
              subtitle="provider を選び、トークンを貼り付けるか環境変数として登録します。"
            />
            <div class="wc-form">
              <FormField label="Provider">
                <Select
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
                </Select>
              </FormField>

              <FormField label="表示名（任意）">
                <Input
                  type="text"
                  value={displayName()}
                  onInput={(e) => setDisplayName(e.currentTarget.value)}
                  placeholder="本番 Cloudflare"
                  autocomplete="off"
                />
              </FormField>

              <Show
                when={isEnvSet()}
                fallback={
                  <Show
                    when={tokenHelper()}
                    fallback={
                      /* No guided helper for this provider — raw fields are the path. */
                      <form
                        class="wc-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void create.run();
                        }}
                      >
                        <Index each={fields()}>
                          {(field) => (
                            <FormField
                              label={field().label}
                              required={field().required}
                            >
                              <Input
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
                            </FormField>
                          )}
                        </Index>
                        <div class="wc-form-actions">
                          <Button
                            variant="primary"
                            type="submit"
                            busy={create.busy()}
                          >
                            {create.busy() ? "登録中..." : "接続を登録"}
                          </Button>
                        </div>
                        <ActionError error={create.error} />
                      </form>
                    }
                  >
                    {(helper) => (
                      <>
                        {/* Primary guided-token flow: open the provider's OWN
                        token screen → create there → paste back. */}
                        <div class="wc-guided">
                          <p class="muted">
                            {descriptor()?.label} に接続します。トークンは{" "}
                            {descriptor()?.label} の画面で作成し、
                            貼り付けるだけです。
                          </p>
                          <ol class="wc-steps">
                            <For each={helper().steps}>
                              {(s) => <li>{s}</li>}
                            </For>
                          </ol>

                          <div class="wc-form-actions">
                            <Button
                              variant="primary"
                              href={helper().createTokenUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {descriptor()?.label} を開いてトークンを作成
                            </Button>
                            {/* OAuth button appears ONLY when the operator wired
                            the upstream client (probed). Otherwise it never
                            renders, so there is no dead button. */}
                            <Show when={oauthAvailable()}>
                              <Button
                                variant="secondary"
                                type="button"
                                onClick={() => startOAuth()}
                              >
                                {descriptor()?.label} で自動接続
                              </Button>
                            </Show>
                          </div>

                          <form
                            class="wc-form"
                            onSubmit={(e) => {
                              e.preventDefault();
                              void createFromHelper.run();
                            }}
                          >
                            <FormField
                              label="作成したトークンを貼り付け"
                              required
                            >
                              <Input
                                type="password"
                                value={helperToken()}
                                onInput={(e) =>
                                  setHelperToken(e.currentTarget.value)
                                }
                                placeholder="ここにトークンを貼り付け"
                                autocomplete="off"
                                spellcheck={false}
                              />
                            </FormField>
                            <div class="wc-form-actions">
                              <Button
                                variant="primary"
                                type="submit"
                                busy={createFromHelper.busy()}
                                icon={<Link size={16} />}
                              >
                                {createFromHelper.busy()
                                  ? "接続中..."
                                  : "接続する"}
                              </Button>
                            </div>
                            <ActionError error={createFromHelper.error} />
                          </form>
                        </div>

                        {/* Advanced fallback: the raw multi-field form, demoted. */}
                        <details class="connection-advanced">
                          <summary>詳細設定（上級者向け）</summary>
                          <form
                            class="wc-form"
                            onSubmit={(e) => {
                              e.preventDefault();
                              void create.run();
                            }}
                          >
                            <Index each={fields()}>
                              {(field) => (
                                <FormField
                                  label={field().label}
                                  required={field().required}
                                >
                                  <Input
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
                                </FormField>
                              )}
                            </Index>
                            <div class="wc-form-actions">
                              <Button
                                variant="secondary"
                                type="submit"
                                busy={create.busy()}
                              >
                                {create.busy() ? "登録中..." : "値を直接登録"}
                              </Button>
                            </div>
                            <ActionError error={create.error} />
                          </form>
                        </details>
                      </>
                    )}
                  </Show>
                }
              >
                {/* Generic Provider Env Set: a free-form provider name +
                    NAME=value env pairs. This makes "any provider via Provider
                    Env Set" reachable from the UI; the backend stores a
                    non-Cloudflare provider as a `provider_env_set` Connection. */}
                <div class="wc-guided">
                  <p class="muted">
                    AWS / GCP / Kubernetes など任意の OpenTofu provider
                    の認証情報を、環境変数 (NAME=value) として登録します。
                    値は書き込み専用で、保存後は env 名のみ表示されます。
                  </p>

                  <form
                    class="wc-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void createEnvSet.run();
                    }}
                  >
                    <FormField label="プロバイダー名" required>
                      <Input
                        type="text"
                        value={envSetProvider()}
                        onInput={(e) => setEnvSetProvider(e.currentTarget.value)}
                        placeholder="aws / google / kubernetes / …"
                        autocomplete="off"
                        spellcheck={false}
                      />
                    </FormField>

                    <Index each={envPairs()}>
                      {(pair, index) => (
                        <div class="wc-env-pair">
                          <FormField label="環境変数名">
                            <Input
                              type="text"
                              value={pair().name}
                              onInput={(e) =>
                                setEnvPair(index, {
                                  name: e.currentTarget.value,
                                })
                              }
                              placeholder="AWS_ACCESS_KEY_ID"
                              autocomplete="off"
                              spellcheck={false}
                            />
                          </FormField>
                          <FormField label="値">
                            <Input
                              type="password"
                              value={pair().value}
                              onInput={(e) =>
                                setEnvPair(index, {
                                  value: e.currentTarget.value,
                                })
                              }
                              placeholder="値を貼り付け"
                              autocomplete="off"
                              spellcheck={false}
                            />
                          </FormField>
                          <Show when={envPairs().length > 1}>
                            <Button
                              variant="ghost"
                              type="button"
                              onClick={() => removeEnvPair(index)}
                              icon={<Trash size={16} />}
                            >
                              削除
                            </Button>
                          </Show>
                        </div>
                      )}
                    </Index>

                    <div class="wc-form-actions">
                      <Button
                        variant="secondary"
                        type="button"
                        onClick={() => addEnvPair()}
                        icon={<Plus size={16} />}
                      >
                        環境変数を追加
                      </Button>
                      <Button
                        variant="primary"
                        type="submit"
                        busy={createEnvSet.busy()}
                      >
                        {createEnvSet.busy() ? "登録中..." : "接続を登録"}
                      </Button>
                    </div>
                    <ActionError error={createEnvSet.error} />
                  </form>
                </div>
              </Show>
            </div>
          </Card>

          {/* ----- list ----- */}
          <Switch>
            <Match when={connections.loading}>
              <Skeleton variant="card" count={2} />
            </Match>
            <Match when={connections.error}>
              <Toast tone="error">
                取得に失敗しました — {(connections.error as ApiError).message}
              </Toast>
            </Match>
            <Match when={connections()}>
              {(list) => (
                <Show
                  when={list().length > 0}
                  fallback={
                    <EmptyState
                      ink
                      icon={<Plug size={26} />}
                      title="接続がありません"
                      message="この Space にはまだ接続がありません。上のフォームから追加できます。"
                    />
                  }
                >
                  <Card>
                    <CardHeader title="登録済みの接続" />
                    <div class="wc-card-stack">
                      <ActionError error={remove.error} />
                      <Show when={testError()}>
                        {(m) => <Toast tone="error">{m()}</Toast>}
                      </Show>
                      <ul class="wc-conn-list">
                        <For each={list()}>
                          {(c) => (
                            <li class="wc-conn-row">
                              <div class="wc-conn-head">
                                <span class="wc-conn-name">
                                  {c.displayName ?? c.id}
                                </span>
                                <ConnectionStatusPill status={c.status} />
                              </div>
                              <div class="wc-conn-meta">
                                <span>{c.provider}</span>
                                <span aria-hidden="true">·</span>
                                <Badge tone="muted">
                                  {connectionScopeLabel(
                                    scopeById().get(c.id) ?? "space",
                                  )}
                                </Badge>
                                <span aria-hidden="true">·</span>
                                <code>{c.envNames.join(", ")}</code>
                              </div>
                              <div class="wc-conn-actions">
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  type="button"
                                  onClick={() => void runTest(c.id)}
                                  busy={testBusyId() === c.id}
                                >
                                  {testBusyId() === c.id
                                    ? "確認中..."
                                    : "接続テスト"}
                                </Button>
                                <Button
                                  variant="danger"
                                  size="sm"
                                  type="button"
                                  onClick={() => void confirmRemove(c)}
                                  disabled={remove.busy()}
                                  icon={<Trash size={14} />}
                                >
                                  削除
                                </Button>
                              </div>
                            </li>
                          )}
                        </For>
                      </ul>
                    </div>
                  </Card>
                </Show>
              )}
            </Match>
          </Switch>
        </Show>
      </div>
    </AppShell>
  );
}
