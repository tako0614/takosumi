/**
 * Workspace settings — 接続. Port of the former ConnectionsView, now fully on the
 * session-authed control surface (`/api/v1/connections*`): list / create /
 * test / revoke all go through control-api (the legacy `/v1/connections` RPC
 * is gone). Secret values are write-only — kept in component state only until
 * the submit resolves, then cleared.
 *
 * The Cloudflare OAuth callback redirects to `/connections?connected=1` plus an
 * opaque `connection_id` / `connection_status`, which the router forwards here
 * query-intact; the one-time banner reads and strips those params. `/new` links
 * may also include a safe `return=/new?...` target so users can create a
 * Provider Connection, then jump back to the add flow.
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
import { ArrowLeft, Link, Plug, Plus, Trash } from "lucide-solid";
import { PROVIDERS, providerDescriptor } from "../../account/lib/api.ts";
import { ActionError, createAction } from "../../account/lib/action.tsx";
import {
  providerConnectionStatusLabel,
  providerConnectionTone,
} from "../../../lib/labels.ts";
import { useConfirmDialog } from "../../../lib/confirm-dialog.ts";
import {
  INSTALL_RETURN_QUERY_PARAM,
  installReturnContext,
  installReturnPathFromContext,
  installReturnPathFromReturnParam,
  type InstallReturnContext,
} from "../../../lib/install-return-context.ts";
import {
  type Connection,
  type ControlApiError,
  type ProviderConnection,
  createConnection,
  isOAuthUnavailable,
  listProviderConnections,
  revokeConnection,
  startCloudflareOAuth,
  testConnection,
} from "../../../lib/control-api.ts";
import { t } from "../../../i18n/index.ts";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  FormField,
  Input,
  Select,
  Skeleton,
  Toast,
} from "../../../components/ui/index.ts";

/** Sentinel `<select>` value for the generic own-key provider path. */
const GENERIC_ENV_PROVIDER_OPTION = "__generic_env_provider__";
const INSTALL_RETURN_STORAGE_KEY = "takosumi.dashboard.installReturn";

interface EnvPair {
  readonly name: string;
  readonly value: string;
}

function providerTail(providerSource: string): string {
  return providerSource.split("/").at(-1) ?? providerSource;
}

function providerConnectionProviderLabel(
  connection: ProviderConnection,
): string {
  const tail = providerTail(connection.providerSource);
  return (
    providerDescriptor(connection.providerSource)?.label ??
    providerDescriptor(tail)?.label ??
    tail
  );
}

export default function ConnectionsTab(props: { readonly spaceId: string }) {
  const { confirm } = useConfirmDialog();
  const spaceId = () => props.spaceId;

  const [providerConnections, { refetch: refetchProviderConnections }] =
    createResource(spaceId, listProviderConnections);
  const [lastCreatedConnectionName, setLastCreatedConnectionName] =
    createSignal<string | null>(null);
  const [lastCreatedConnectionId, setLastCreatedConnectionId] = createSignal<
    string | null
  >(null);
  const [lastCreatedVerifiedHint, setLastCreatedVerifiedHint] =
    createSignal(false);
  const installReturn = currentInstallReturnContext();
  const [createFormOpen, setCreateFormOpen] = createSignal(
    Boolean(installReturn),
  );
  const hasProviderConnections = () => (providerConnections() ?? []).length > 0;
  const shouldShowCreateForm = () =>
    createFormOpen() ||
    (!providerConnections.loading &&
      !providerConnections.error &&
      !hasProviderConnections());

  const refreshConnections = async () => {
    await refetchProviderConnections();
  };

  const afterConnectionCreated = async (connection: Connection) => {
    setLastCreatedConnectionName(connection.displayName ?? connection.id);
    setLastCreatedConnectionId(connection.id);
    setLastCreatedVerifiedHint(false);
    clearForm();
    await refreshConnections();
    if (!installReturn) setCreateFormOpen(false);
  };
  const installReturnHref = installReturn
    ? installReturnPathFromContext(installReturn)
    : undefined;
  const installReturnDetails = () =>
    installReturn
      ? t("conn.return.subtitle", {
          source: installReturn.sourceLabel,
          ref: installReturn.displayRef || t("conn.return.defaultRef"),
          path: installReturn.path || t("conn.return.rootPath"),
        })
      : "";

  // ----- register form state -----------------------------------------------
  const [provider, setProvider] = createSignal(PROVIDERS[0]?.provider ?? "");
  const [displayName, setDisplayName] = createSignal("");
  // Secret material lives ONLY for the lifetime of the form; cleared on submit.
  const [values, setValues] = createSignal<Record<string, string>>({});
  const [helperToken, setHelperToken] = createSignal("");
  const [helperCloudflareAccountId, setHelperCloudflareAccountId] =
    createSignal("");
  const [oauthBusy, setOauthBusy] = createSignal(false);

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
  const scopeHintsFromConnectionValues = (
    providerId: string,
    connectionValues: Readonly<Record<string, string>>,
  ):
    | { readonly accountId?: string; readonly awsRegion?: string }
    | undefined => {
    if (providerId === "cloudflare") {
      const accountId = connectionValues.CLOUDFLARE_ACCOUNT_ID?.trim();
      return accountId ? { accountId } : undefined;
    }
    if (providerId === "aws") {
      const awsRegion = connectionValues.AWS_REGION?.trim();
      return awsRegion ? { awsRegion } : undefined;
    }
    return undefined;
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
    setHelperCloudflareAccountId("");
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
    if (params.get("connected")) {
      setOauthNotice({ kind: "ok" });
      const connectionId = params.get("connection_id");
      if (connectionId && !/[\r\n\0]/u.test(connectionId)) {
        setLastCreatedConnectionId(connectionId);
      }
      setLastCreatedVerifiedHint(
        params.get("connection_status") === "verified",
      );
    } else {
      const err = params.get("connection_error");
      if (err) setOauthNotice({ kind: "error", code: err });
    }
    if (
      params.has("connected") ||
      params.has("connection_error") ||
      params.has("connection_id") ||
      params.has("connection_status")
    ) {
      params.delete("connected");
      params.delete("connection_error");
      params.delete("connection_id");
      params.delete("connection_status");
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
    const cloudflareAccountId = helperCloudflareAccountId().trim();
    if (d.provider === "cloudflare" && !cloudflareAccountId) {
      throw new Error(
        t("conn.error.fieldRequired", {
          field: t("conn.provider.cloudflare.accountId.label"),
        }),
      );
    }
    const submitValues: Record<string, string> = { [helper.envName]: token };
    if (cloudflareAccountId) {
      submitValues.CLOUDFLARE_ACCOUNT_ID = cloudflareAccountId;
    }
    const connection = await createConnection({
      spaceId: spaceId(),
      provider: d.provider,
      displayName: displayName().trim() || undefined,
      scopeHints: scopeHintsFromConnectionValues(d.provider, submitValues),
      values: submitValues,
    });
    await afterConnectionCreated(connection);
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
    const connection = await createConnection({
      spaceId: spaceId(),
      provider: d.provider,
      displayName: displayName().trim() || undefined,
      scopeHints: scopeHintsFromConnectionValues(d.provider, submitValues),
      values: submitValues,
    });
    await afterConnectionCreated(connection);
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
    const connection = await createConnection({
      spaceId: spaceId(),
      provider: name,
      displayName: displayName().trim() || undefined,
      values: submitValues,
    });
    await afterConnectionCreated(connection);
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

  const startOAuth = async () => {
    if (!oauthAvailable()) return;
    setOauthBusy(true);
    setOauthNotice(null);
    try {
      const started = await startCloudflareOAuth({
        spaceId: spaceId(),
        displayName: displayName().trim() || undefined,
      });
      window.location.assign(started.authorizationUrl);
    } catch (e) {
      if (isOAuthUnavailable(e)) return;
      setOauthNotice({ kind: "error", code: "start_failed" });
    } finally {
      setOauthBusy(false);
    }
  };

  // Per-connection test / remove.
  const [testBusyId, setTestBusyId] = createSignal<string | null>(null);
  const [testError, setTestError] = createSignal<string | null>(null);

  const runTest = async (id: string) => {
    setTestBusyId(id);
    setTestError(null);
    try {
      const result = (await testConnection(id)) as
        | { readonly status?: string; readonly detail?: string }
        | undefined;
      await refreshConnections();
      if (result?.status && result.status !== "verified") {
        setLastCreatedVerifiedHint(false);
        setTestError(
          result.detail ??
            t("conn.test.notReady", {
              status: result.status,
            }),
        );
      } else if (result?.status === "verified") {
        setLastCreatedVerifiedHint(true);
      }
    } catch (e) {
      setTestError(e instanceof Error ? e.message : String(e));
    } finally {
      setTestBusyId(null);
    }
  };

  const remove = createAction(async (id: string) => {
    await revokeConnection(id);
    if (lastCreatedConnectionId() === id) {
      setLastCreatedConnectionId(null);
      setLastCreatedConnectionName(null);
      setLastCreatedVerifiedHint(false);
    }
    await refreshConnections();
  });

  const providerConnectionForConnectionId = (connectionId: string | null) =>
    (providerConnections() ?? []).find(
      (connection) => connection.id === connectionId,
    );
  const lastCreatedProviderConnection = () =>
    providerConnectionForConnectionId(lastCreatedConnectionId());
  const lastCreatedReady = () =>
    lastCreatedProviderConnection()?.status === "ready" ||
    lastCreatedVerifiedHint();
  const shouldOfferInstallReturn = () =>
    !lastCreatedConnectionId() || lastCreatedReady();
  const confirmRemoveProviderConnection = async (
    connection: ProviderConnection,
  ) => {
    const ok = await confirm({
      title: t("conn.remove.confirmTitle"),
      message: t("conn.remove.confirmMessage", {
        name: connection.displayName ?? connection.id,
      }),
      confirmText: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    void remove.run(connection.id);
  };

  const providerConnectionList = () => (
    <ul class="wc-conn-list">
      <For each={providerConnections() ?? []}>
        {(connection) => (
          <li class="wc-conn-row">
            <div class="wc-conn-head">
              <span class="wc-conn-name">
                {connection.displayName ||
                  providerConnectionProviderLabel(connection)}
              </span>
              <Badge tone={providerConnectionTone(connection.status)}>
                {providerConnectionStatusLabel(connection.status)}
              </Badge>
            </div>
            <div class="wc-conn-meta">
              <span>{providerConnectionProviderLabel(connection)}</span>
            </div>
            <div class="wc-conn-actions">
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => void runTest(connection.id)}
                busy={testBusyId() === connection.id}
              >
                {testBusyId() === connection.id
                  ? t("conn.testing")
                  : t("conn.test")}
              </Button>
              <Button
                variant="danger"
                size="sm"
                type="button"
                onClick={() => void confirmRemoveProviderConnection(connection)}
                disabled={remove.busy()}
                icon={<Trash size={14} />}
              >
                {t("common.delete")}
              </Button>
            </div>
          </li>
        )}
      </For>
    </ul>
  );

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

      <Show when={installReturn && installReturnHref}>
        <Card>
          <CardHeader
            title={t("conn.return.title", {
              name: installReturn?.label ?? "",
            })}
            subtitle={installReturnDetails()}
            actions={
              <Show
                when={shouldOfferInstallReturn()}
                fallback={
                  <Show when={lastCreatedConnectionId()}>
                    {(id) => (
                      <Button
                        variant="secondary"
                        type="button"
                        busy={testBusyId() === id()}
                        onClick={() => void runTest(id())}
                      >
                        {testBusyId() === id()
                          ? t("conn.testing")
                          : t("conn.saved.testCta")}
                      </Button>
                    )}
                  </Show>
                }
              >
                <Button
                  variant="secondary"
                  href={installReturnHref}
                  icon={<ArrowLeft size={16} />}
                  onClick={clearStoredInstallReturn}
                >
                  {t("conn.return.cta")}
                </Button>
              </Show>
            }
          />
        </Card>
      </Show>

      <Show when={lastCreatedConnectionName()}>
        {(name) => (
          <Toast tone="success">
            <span class="wc-inline-feedback">
              <span>
                {t(
                  lastCreatedReady()
                    ? "conn.saved.message"
                    : "conn.saved.needsTest",
                  {
                    name: name(),
                  },
                )}
              </span>
              <Show
                when={lastCreatedReady() && installReturnHref}
                fallback={
                  <Show when={lastCreatedConnectionId()}>
                    {(id) => (
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        busy={testBusyId() === id()}
                        onClick={() => void runTest(id())}
                      >
                        {testBusyId() === id()
                          ? t("conn.testing")
                          : t("conn.saved.testCta")}
                      </Button>
                    )}
                  </Show>
                }
              >
                {(href) => (
                  <Button
                    variant="secondary"
                    size="sm"
                    href={href()}
                    icon={<ArrowLeft size={14} />}
                    onClick={clearStoredInstallReturn}
                  >
                    {t("conn.saved.returnCta")}
                  </Button>
                )}
              </Show>
            </span>
          </Toast>
        )}
      </Show>

      <Show when={(providerConnections() ?? []).length > 0}>
        <Card>
          <CardHeader
            title={t("conn.providerConnections.title")}
            actions={
              <Show when={!createFormOpen()}>
                <Button
                  variant="primary"
                  size="sm"
                  type="button"
                  icon={<Plus size={14} />}
                  onClick={() => setCreateFormOpen(true)}
                >
                  {t("conn.add.open")}
                </Button>
              </Show>
            }
          />
          <ActionError error={remove.error} />
          <Show when={testError()}>
            {(m) => <Toast tone="error">{m()}</Toast>}
          </Show>
          {providerConnectionList()}
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
      <Show when={shouldShowCreateForm()}>
        <Card>
          <CardHeader
            title={t("conn.add.title")}
            actions={
              <Show when={hasProviderConnections()}>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => setCreateFormOpen(false)}
                >
                  {t("conn.add.close")}
                </Button>
              </Show>
            }
          />
          <div class="wc-form">
            <FormField label={t("conn.add.provider")}>
              <Select
                id="connection-provider"
                name="provider"
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
              </Select>
            </FormField>

            <FormField label={t("conn.add.displayName")}>
              <Input
                id="connection-display-name"
                name="displayName"
                type="text"
                value={displayName()}
                onInput={(e) => setDisplayName(e.currentTarget.value)}
                placeholder={t("conn.add.displayNamePlaceholder")}
                autocomplete="off"
              />
            </FormField>

            <Show when={!isGenericEnvProvider()}>
              <details class="connection-advanced">
                <summary>{t("conn.custom.summary")}</summary>
                <p class="muted">{t("conn.custom.body")}</p>
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => setProvider(GENERIC_ENV_PROVIDER_OPTION)}
                >
                  {t("conn.custom.use")}
                </Button>
              </details>
            </Show>
            <Show when={isGenericEnvProvider()}>
              <div class="wc-form-actions">
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => setProvider(PROVIDERS[0]?.provider ?? "")}
                >
                  {t("conn.custom.back")}
                </Button>
              </div>
            </Show>

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
                              id={`connection-field-${field().envName}`}
                              name={`field:${field().envName}`}
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
                              busy={oauthBusy()}
                              onClick={() => void startOAuth()}
                            >
                              {t("conn.guided.oauth", {
                                provider: descriptor()?.label ?? "",
                              })}
                            </Button>
                          </Show>
                        </div>
                        <details class="connection-advanced connection-help">
                          <summary>{t("conn.guided.stepsSummary")}</summary>
                          <ol class="wc-steps">
                            <For each={helper().steps}>
                              {(s) => <li>{s}</li>}
                            </For>
                          </ol>
                        </details>

                        <form
                          class="wc-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void createFromHelper.run();
                          }}
                        >
                          <FormField
                            label={t("conn.guided.pasteLabel")}
                            required
                          >
                            <Input
                              id="connection-helper-token"
                              name="helperToken"
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
                          <Show when={descriptor()?.provider === "cloudflare"}>
                            <FormField
                              label={t(
                                "conn.provider.cloudflare.accountId.label",
                              )}
                              required
                            >
                              <Input
                                id="connection-helper-cloudflare-account-id"
                                name="helperCloudflareAccountId"
                                type="text"
                                value={helperCloudflareAccountId()}
                                onInput={(e) =>
                                  setHelperCloudflareAccountId(
                                    e.currentTarget.value,
                                  )
                                }
                                placeholder={t(
                                  "conn.provider.cloudflare.accountId.placeholder",
                                )}
                                autocomplete="off"
                                spellcheck={false}
                              />
                            </FormField>
                          </Show>
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
                                  id={`connection-advanced-field-${field().envName}`}
                                  name={`advancedField:${field().envName}`}
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
                <form
                  class="wc-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void createGenericEnvProvider.run();
                  }}
                >
                  <FormField label={t("conn.genericEnv.providerName")} required>
                    <Input
                      id="connection-generic-provider"
                      name="genericProvider"
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
                            id={`connection-generic-env-name-${index}`}
                            name={`genericEnvName:${index}`}
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
                            id={`connection-generic-env-value-${index}`}
                            name={`genericEnvValue:${index}`}
                            type="password"
                            value={pair().value}
                            onInput={(e) =>
                              setEnvPair(index, {
                                value: e.currentTarget.value,
                              })
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
      </Show>

      <Show when={providerConnections.loading}>
        <Skeleton variant="card" count={2} />
      </Show>
      <Show
        when={
          !providerConnections.loading &&
          !providerConnections.error &&
          (providerConnections() ?? []).length === 0 &&
          !shouldShowCreateForm()
        }
      >
        <EmptyState
          icon={<Plug size={26} />}
          title={t("spaceSettings.tab.connections")}
          message={t("conn.list.empty")}
        />
      </Show>
    </div>
  );
}

function currentInstallReturnContext(): InstallReturnContext | undefined {
  if (typeof window === "undefined") return undefined;
  const params = new URLSearchParams(window.location.search);
  const explicitReturn = params.get(INSTALL_RETURN_QUERY_PARAM);
  const explicitReturnPath = installReturnPathFromReturnParam(explicitReturn);
  if (explicitReturnPath) {
    storeInstallReturn(explicitReturnPath);
    return installReturnContext(explicitReturnPath);
  }

  if (!params.has("connected") && !params.has("connection_error")) {
    return undefined;
  }

  const storedReturn = readStoredInstallReturn();
  const storedReturnPath = installReturnPathFromReturnParam(storedReturn);
  if (!storedReturnPath) {
    clearStoredInstallReturn();
    return undefined;
  }
  return installReturnContext(storedReturnPath);
}

function storeInstallReturn(returnPath: string): void {
  try {
    window.sessionStorage.setItem(INSTALL_RETURN_STORAGE_KEY, returnPath);
  } catch {
    // Storage may be blocked; the explicit URL return param still works.
  }
}

function readStoredInstallReturn(): string | null {
  try {
    return window.sessionStorage.getItem(INSTALL_RETURN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function clearStoredInstallReturn(): void {
  try {
    window.sessionStorage.removeItem(INSTALL_RETURN_STORAGE_KEY);
  } catch {
    // Ignore storage failures; the navigation itself is the important action.
  }
}
