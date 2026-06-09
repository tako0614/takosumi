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
  listConnections as listControlConnections,
  listOperatorConnectionDefaults,
} from "../../lib/control-api.ts";

// Reuse the apps screen's space-id memory so a previously-selected space
// carries across both screens.
const STORAGE_KEY = "tg_apps_space_id";

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
  const initial = typeof localStorage !== "undefined"
    ? (localStorage.getItem(STORAGE_KEY) ?? "")
    : "";
  const [spaceId, setSpaceId] = createSignal(initial);
  const [draft, setDraft] = createSignal(initial);
  const { confirm } = useConfirmDialog();

  const applySpace = (e: Event) => {
    e.preventDefault();
    const next = draft().trim();
    setSpaceId(next);
    if (next) localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
  };

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
    async (id) => id ? await listOperatorConnectionDefaults(id) : [],
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

  const fields = createMemo(() => providerDescriptor(provider())?.fields ?? []);

  const setFieldValue = (envName: string, value: string) => {
    setValues((prev) => ({ ...prev, [envName]: value }));
  };

  const clearForm = () => {
    setValues({});
    setDisplayName("");
  };

  const create = createAction(async () => {
    const space = spaceId();
    if (!space) throw new Error("space を指定してください。");
    const descriptor = providerDescriptor(provider());
    if (!descriptor) throw new Error("provider が不正です。");
    const submitValues: Record<string, string> = {};
    for (const field of descriptor.fields) {
      const raw = (values()[field.envName] ?? "").trim();
      if (field.required && raw.length === 0) {
        throw new Error(`${field.label} は必須です。`);
      }
      if (raw.length > 0) submitValues[field.envName] = raw;
    }
    await rpc.connections.create({
      spaceId: space,
      provider: descriptor.provider,
      displayName: displayName().trim() || undefined,
      values: submitValues,
    });
    // Clear secrets from memory the moment the submit resolves.
    clearForm();
    await refetch();
  });

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
      message: `本当に ${c.displayName ?? c.id} を削除しますか？ ` +
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
                <th>Capability</th>
                <th>Provider</th>
                <th>Connection</th>
              </tr>
            </thead>
            <tbody>
              <For each={operatorDefaults() ?? []}>
                {(d) => (
                  <tr>
                    <td><code>{d.capability}</code></td>
                    <td>{d.provider}</td>
                    <td><code>{d.connectionId}</code></td>
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

      <section class="space-picker">
        <form onSubmit={applySpace}>
          <label>
            Space ID
            <input
              type="text"
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              placeholder="space_xxxxxx"
              autocomplete="off"
            />
          </label>
          <button class="btn btn-secondary" type="submit">
            表示
          </button>
        </form>
      </section>

      <Show
        when={hasSpace()}
        fallback={
          <section class="empty-state">
            <p>space を指定すると接続一覧を表示します。</p>
          </section>
        }
      >
        {/* ----- register form ----- */}
        <section class="detail-section">
          <h2>接続を追加</h2>
          <form
            class="connection-form"
            onSubmit={(e) => {
              e.preventDefault();
              void create.run();
            }}
          >
            <label class="form-field">
              Provider
              <select
                value={provider()}
                onChange={(e) => {
                  setProvider(e.currentTarget.value);
                  // Switching provider drops any half-entered secret values.
                  setValues({});
                }}
              >
                <For each={PROVIDERS}>
                  {(p) => <option value={p.provider}>{p.label}</option>}
                </For>
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

            <Index each={fields()}>
              {(field) => (
                <label class="form-field">
                  {field().label}
                  <Show when={field().required}>
                    <span class="form-required" aria-hidden="true">*</span>
                  </Show>
                  <input
                    type={field().secret ? "password" : "text"}
                    value={values()[field().envName] ?? ""}
                    onInput={(e) =>
                      setFieldValue(field().envName, e.currentTarget.value)}
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
                    <p>この space にはまだ接続がありません。</p>
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
                              {connectionScopeLabel(scopeById().get(c.id) ?? "space")}
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
                              {testBusyId() === c.id ? "確認中..." : "接続テスト"}
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
