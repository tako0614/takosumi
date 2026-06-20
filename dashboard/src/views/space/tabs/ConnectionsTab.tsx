/**
 * Space settings — 接続. Port of the former ConnectionsView, now fully on the
 * session-authed control surface (`/api/v1/connections*`): list / create /
 * test / revoke all go through control-api (the legacy `/v1/connections` RPC
 * is gone). Secret values are write-only — kept in component state only until
 * the submit resolves, then cleared.
 *
 * The Cloudflare OAuth callback redirects to `/connections?connected=1`, which
 * the router forwards here query-intact; the one-time banner reads and strips
 * those params.
 */
import "../../../styles/wave-c.css";
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
import { PROVIDERS, providerDescriptor } from "../../account/lib/api.ts";
import { ActionError, createAction } from "../../account/lib/action.tsx";
import { connectionStatusLabel, connectionTone } from "../../../lib/labels.ts";
import { useConfirmDialog } from "../../../lib/confirm-dialog.ts";
import {
  type Connection,
  type ControlApiError,
  type ProviderConnection,
  createConnection,
  isOAuthUnavailable,
  listConnections,
  listProviderConnections,
  revokeConnection,
  startCloudflareOAuth,
  testConnection,
} from "../../../lib/control-api.ts";
import { type MessageKey, t } from "../../../i18n/index.ts";
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
  Select,
  Skeleton,
  StatusBadge,
  Toast,
} from "../../../components/ui/index.ts";

/** Sentinel `<select>` value for the generic own-key provider path. */
const GENERIC_ENV_PROVIDER_OPTION = "__generic_env_provider__";

interface EnvPair {
  readonly name: string;
  readonly value: string;
}

const SCOPE_KEY: Record<string, MessageKey> = {
  operator: "conn.scope.operator",
  space: "conn.scope.space",
};

function scopeLabel(scope: string | undefined): string {
  if (!scope) return t("conn.scope.space");
  const key = SCOPE_KEY[scope];
  return key ? t(key) : scope;
}

export default function ConnectionsTab(props: { readonly spaceId: string }) {
  const { confirm } = useConfirmDialog();
  const spaceId = () => props.spaceId;

  const [connections, { refetch }] = createResource(spaceId, listConnections);
  const [providerConnections] = createResource(
    spaceId,
    listProviderConnections,
  );

  // ----- register form state -----------------------------------------------
  const [provider, setProvider] = createSignal(PROVIDERS[0]?.provider ?? "");
  const [displayName, setDisplayName] = createSignal("");
  // Secret material lives ONLY for the lifetime of the form; cleared on submit.
  const [values, setValues] = createSignal<Record<string, string>>({});
  const [helperToken, setHelperToken] = createSignal("");

  const [genericEnvProvider, setGenericEnvProvider] = createSignal("");
  const [envPairs, setEnvPairs] = createSignal<readonly EnvPair[]>([
    { name: "", value: "" },
  ]);
  const isGenericEnvProvider = () => provider() === GENERIC_ENV_PROVIDER_OPTION;

  const descriptor = createMemo(() =>
    isGenericEnvProvider() ? undefined : providerDescriptor(provider()),
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
    setGenericEnvProvider("");
    setEnvPairs([{ name: "", value: "" }]);
  };

  // ----- one-time URL result banner (OAuth backend callback) ---------------
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

  // Primary guided-token submit.
  const createFromHelper = createAction(async () => {
    const helper = tokenHelper();
    const d = descriptor();
    if (!helper || !d) throw new Error(t("conn.error.invalidProvider"));
    const token = helperToken().trim();
    if (!token) throw new Error(t("conn.error.tokenRequired"));
    await createConnection({
      spaceId: spaceId(),
      provider: d.provider,
      displayName: displayName().trim() || undefined,
      values: { [helper.envName]: token },
    });
    clearForm();
    await refetch();
  });

  // Advanced raw-field submit.
  const create = createAction(async () => {
    const d = descriptor();
    if (!d) throw new Error(t("conn.error.invalidProvider"));
    const submitValues: Record<string, string> = {};
    for (const field of d.fields) {
      const raw = (values()[field.envName] ?? "").trim();
      if (field.required && raw.length === 0) {
        throw new Error(t("conn.error.fieldRequired", { field: field.label }));
      }
      if (raw.length > 0) submitValues[field.envName] = raw;
    }
    await createConnection({
      spaceId: spaceId(),
      provider: d.provider,
      displayName: displayName().trim() || undefined,
      values: submitValues,
    });
    clearForm();
    await refetch();
  });

  // Generic own-key Provider Connection submit.
  const createGenericEnvProvider = createAction(async () => {
    const name = genericEnvProvider().trim();
    if (!name) throw new Error(t("conn.genericEnv.providerRequired"));
    if (name === "cloudflare") {
      throw new Error(t("conn.genericEnv.cloudflareGuided"));
    }
    const submitValues: Record<string, string> = {};
    for (const pair of envPairs()) {
      const envName = pair.name.trim();
      const value = pair.value.trim();
      if (envName.length === 0 && value.length === 0) continue;
      if (envName.length === 0) {
        throw new Error(t("conn.genericEnv.nameRequired"));
      }
      submitValues[envName] = value;
    }
    if (Object.keys(submitValues).length === 0) {
      throw new Error(t("conn.genericEnv.oneRequired"));
    }
    await createConnection({
      spaceId: spaceId(),
      provider: name,
      displayName: displayName().trim() || undefined,
      values: submitValues,
    });
    clearForm();
    await refetch();
  });

  // ----- optional Cloudflare OAuth (probed; no dead button) ------------------
  const oauthProbeKey = createMemo(() => {
    const d = descriptor();
    if (!d?.oauthCandidate) return null;
    return { spaceId: spaceId(), provider: d.provider };
  });
  const [oauthProbe] = createResource(oauthProbeKey, async (key) => {
    try {
      const started = await startCloudflareOAuth({ spaceId: key.spaceId });
      return { authorizationUrl: started.authorizationUrl };
    } catch (e) {
      if (isOAuthUnavailable(e)) return { authorizationUrl: null };
      return { authorizationUrl: null };
    }
  });
  const oauthAvailable = createMemo(() => !!oauthProbe()?.authorizationUrl);

  const startOAuth = () => {
    const url = oauthProbe()?.authorizationUrl;
    if (!url) return;
    window.location.assign(url);
  };

  // Per-connection test / remove.
  const [testBusyId, setTestBusyId] = createSignal<string | null>(null);
  const [testError, setTestError] = createSignal<string | null>(null);

  const runTest = async (id: string) => {
    setTestBusyId(id);
    setTestError(null);
    try {
      await testConnection(id);
      await refetch();
    } catch (e) {
      setTestError(e instanceof Error ? e.message : String(e));
    } finally {
      setTestBusyId(null);
    }
  };

  const remove = createAction(async (id: string) => {
    await revokeConnection(id);
    await refetch();
  });

  const confirmRemove = async (c: Connection) => {
    const ok = await confirm({
      title: t("conn.remove.confirmTitle"),
      message: t("conn.remove.confirmMessage", { name: c.displayName ?? c.id }),
      confirmText: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    void remove.run(c.id);
  };

  const providerConnectionColumns: readonly Column<ProviderConnection>[] = [
    {
      header: t("conn.providerConnections.provider"),
      cell: (d) => <code class="wc-code">{d.providerSource}</code>,
    },
    {
      header: t("conn.providerConnections.name"),
      cell: (d) => d.displayName,
    },
    {
      header: t("conn.providerConnections.ownership"),
      cell: (d) => (
        <Badge tone="neutral">{t("conn.ownership.ownKey")}</Badge>
      ),
    },
    {
      header: t("conn.providerConnections.status"),
      cell: (d) => (
        <Badge tone={d.status === "ready" ? "ok" : "warn"}>{d.status}</Badge>
      ),
    },
  ];

  return (
    <div class="wc-stack">
      {/* Result banner from the Cloudflare OAuth backend callback redirect. */}
      <Show when={oauthNotice()}>
        {(notice) => (
          <Switch>
            <Match when={notice().kind === "ok"}>
              <Toast tone="success">{t("conn.oauth.connected")}</Toast>
            </Match>
            <Match when={notice().kind === "error"}>
              <Toast tone="error">{t("conn.oauth.failed")}</Toast>
            </Match>
          </Switch>
        )}
      </Show>

      <Show when={(providerConnections() ?? []).length > 0}>
        <Card>
          <CardHeader
            title={t("conn.providerConnections.title")}
            subtitle={t("conn.providerConnections.subtitle")}
          />
          <DataTable
            columns={providerConnectionColumns}
            rows={providerConnections() ?? []}
            rowKey={(d) => d.id}
          />
        </Card>
      </Show>
      <Show when={providerConnections.error}>
        <Toast tone="error">
          {t("common.fetchFailed", {
            message: (providerConnections.error as ControlApiError).message,
          })}
        </Toast>
      </Show>

      {/* ----- register form ----- */}
      <Card>
        <CardHeader
          title={t("conn.add.title")}
          subtitle={t("conn.add.subtitle")}
        />
        <div class="wc-form">
          <FormField label={t("conn.add.provider")}>
            <Select
              value={provider()}
              onChange={(e) => {
                setProvider(e.currentTarget.value);
                // Switching provider drops any half-entered secret values.
                setValues({});
                setHelperToken("");
                setGenericEnvProvider("");
                setEnvPairs([{ name: "", value: "" }]);
              }}
            >
              <For each={PROVIDERS}>
                {(p) => <option value={p.provider}>{p.label}</option>}
              </For>
              <option value={GENERIC_ENV_PROVIDER_OPTION}>
                {t("conn.add.genericEnvOption")}
              </option>
            </Select>
          </FormField>

          <FormField label={t("conn.add.displayName")}>
            <Input
              type="text"
              value={displayName()}
              onInput={(e) => setDisplayName(e.currentTarget.value)}
              placeholder={t("conn.add.displayNamePlaceholder")}
              autocomplete="off"
            />
          </FormField>

          <Show
            when={isGenericEnvProvider()}
            fallback={
              <Show
                when={tokenHelper()}
                fallback={
                  /* No guided helper — raw fields are the path. */
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
                        {create.busy()
                          ? t("conn.registering")
                          : t("conn.register")}
                      </Button>
                    </div>
                    <ActionError error={create.error} />
                  </form>
                }
              >
                {(helper) => (
                  <>
                    {/* Guided-token flow: provider's own token screen → paste. */}
                    <div class="wc-guided">
                      <p class="muted">
                        {t("conn.guided.intro", {
                          provider: descriptor()?.label ?? "",
                        })}
                      </p>
                      <ol class="wc-steps">
                        <For each={helper().steps}>{(s) => <li>{s}</li>}</For>
                      </ol>

                      <div class="wc-form-actions">
                        <Button
                          variant="primary"
                          href={helper().createTokenUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t("conn.guided.openProvider", {
                            provider: descriptor()?.label ?? "",
                          })}
                        </Button>
                        <Show when={oauthAvailable()}>
                          <Button
                            variant="secondary"
                            type="button"
                            onClick={() => startOAuth()}
                          >
                            {t("conn.guided.oauth", {
                              provider: descriptor()?.label ?? "",
                            })}
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
                        <FormField label={t("conn.guided.pasteLabel")} required>
                          <Input
                            type="password"
                            value={helperToken()}
                            onInput={(e) =>
                              setHelperToken(e.currentTarget.value)
                            }
                            placeholder={t("conn.guided.pastePlaceholder")}
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
                              ? t("conn.guided.connecting")
                              : t("conn.guided.connect")}
                          </Button>
                        </div>
                        <ActionError error={createFromHelper.error} />
                      </form>
                    </div>

                    {/* Advanced fallback: raw multi-field form, demoted. */}
                    <details class="connection-advanced">
                      <summary>{t("conn.advanced.summary")}</summary>
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
                            {create.busy()
                              ? t("conn.registering")
                              : t("conn.advanced.register")}
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
            {/* Generic own-key Provider Connection editor. */}
            <div class="wc-guided">
              <p class="muted">{t("conn.genericEnv.intro")}</p>

              <form
                class="wc-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void createGenericEnvProvider.run();
                }}
              >
                <FormField label={t("conn.genericEnv.providerName")} required>
                  <Input
                    type="text"
                    value={genericEnvProvider()}
                    onInput={(e) =>
                      setGenericEnvProvider(e.currentTarget.value)
                    }
                    placeholder="aws / google / kubernetes / …"
                    autocomplete="off"
                    spellcheck={false}
                  />
                </FormField>

                <Index each={envPairs()}>
                  {(pair, index) => (
                    <div class="wc-env-pair">
                      <FormField label={t("conn.genericEnv.envName")}>
                        <Input
                          type="text"
                          value={pair().name}
                          onInput={(e) =>
                            setEnvPair(index, { name: e.currentTarget.value })
                          }
                          placeholder="AWS_ACCESS_KEY_ID"
                          autocomplete="off"
                          spellcheck={false}
                        />
                      </FormField>
                      <FormField label={t("conn.genericEnv.value")}>
                        <Input
                          type="password"
                          value={pair().value}
                          onInput={(e) =>
                            setEnvPair(index, { value: e.currentTarget.value })
                          }
                          placeholder={t("conn.genericEnv.valuePlaceholder")}
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
                          {t("common.delete")}
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
                    {t("conn.genericEnv.addRow")}
                  </Button>
                  <Button
                    variant="primary"
                    type="submit"
                    busy={createGenericEnvProvider.busy()}
                  >
                    {createGenericEnvProvider.busy()
                      ? t("conn.registering")
                      : t("conn.register")}
                  </Button>
                </div>
                <ActionError error={createGenericEnvProvider.error} />
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
            {t("common.fetchFailed", {
              message: (connections.error as ControlApiError).message,
            })}
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
                  title={t("spaceSettings.tab.connections")}
                  message={t("conn.list.empty")}
                />
              }
            >
              <Card>
                <CardHeader title={t("conn.list.title")} />
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
                            <StatusBadge
                              status={c.status}
                              label={connectionStatusLabel}
                              tone={connectionTone}
                            />
                          </div>
                          <div class="wc-conn-meta">
                            <span>{c.provider}</span>
                            <span aria-hidden="true">·</span>
                            <Badge tone="muted">{scopeLabel(c.scope)}</Badge>
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
                                ? t("conn.testing")
                                : t("conn.test")}
                            </Button>
                            <Show when={c.status !== "revoked"}>
                              <Button
                                variant="danger"
                                size="sm"
                                type="button"
                                onClick={() => void confirmRemove(c)}
                                disabled={remove.busy()}
                                icon={<Trash size={14} />}
                              >
                                {t("common.delete")}
                              </Button>
                            </Show>
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
    </div>
  );
}
