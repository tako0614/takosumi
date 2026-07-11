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
import {
  isProviderEnvName,
  isReservedProviderEnvName,
} from "takosumi-contract";
import { PROVIDERS, providerDescriptor } from "../../account/lib/api.ts";
import { ActionError, createAction } from "../../account/lib/action.tsx";
import {
  providerConnectionStatusLabel,
  providerConnectionTone,
} from "../../../lib/labels.ts";
import { useConfirmDialog } from "../../../lib/confirm-dialog.ts";
import { friendlyError } from "../../../lib/error-copy.ts";
import {
  INSTALL_RETURN_QUERY_PARAM,
  installReturnContext,
  installReturnPathFromContext,
  installReturnPathFromReturnParam,
  type InstallReturnContext,
} from "../../../lib/install-return-context.ts";
import {
  type Connection,
  type ProviderConnection,
  createConnection,
  listProviderConnections,
  revokeConnection,
  testConnection,
} from "../../../lib/control-api.ts";
import { formatDateTime, t } from "../../../i18n/index.ts";
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

/** Sentinel `<select>` value for the custom provider credential path. */
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

/**
 * Maps a known Cloudflare-OAuth callback failure code (`missing_code` /
 * `oauth_failed` / `forbidden`, per the account-plane redirect) to a localized
 * hint. Unknown codes fall back to the generic sentence; the raw code always
 * rides along in a folded detail area so support can still see it.
 */
function oauthErrorHint(code: string): string | null {
  switch (code) {
    case "missing_code":
      return t("conn.oauth.error.missingCode");
    case "forbidden":
      return t("conn.oauth.error.forbidden");
    case "oauth_failed":
      return t("conn.oauth.error.oauthFailed");
    default:
      return null;
  }
}

export default function ConnectionsTab(props: {
  readonly workspaceId: string;
}) {
  const { confirm } = useConfirmDialog();
  const workspaceId = () => props.workspaceId;

  const [providerConnections, { refetch: refetchProviderConnections }] =
    createResource(workspaceId, listProviderConnections);
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
  // An errored resource THROWS on read; every data read goes through this
  // guarded accessor so a failed list surfaces the error toast below instead
  // of crashing the tab (mirrors RunsListView / RunGroupView).
  const providerConnectionRows = (): readonly ProviderConnection[] =>
    providerConnections.error ? [] : (providerConnections.latest ?? []);
  const hasProviderConnections = () => providerConnectionRows().length > 0;
  const shouldShowCreateForm = () => createFormOpen();

  const refreshConnections = async () => {
    await refetchProviderConnections();
  };

  const afterConnectionCreated = async (connection: Connection) => {
    // Never show a raw conn_… id in the toast — fall back to the provider name.
    setLastCreatedConnectionName(
      connection.displayName ||
        providerDescriptor(connection.provider)?.label ||
        connection.provider,
    );
    setLastCreatedConnectionId(connection.id);
    setLastCreatedVerifiedHint(false);
    clearForm();
    await refreshConnections();
    if (!installReturn) setCreateFormOpen(false);
  };
  const installReturnHref = installReturn
    ? installReturnPathFromContext(installReturn)
    : undefined;
  // ----- register form state -----------------------------------------------
  // Default to the GUIDED presets (Cloudflare pre-scoped token link, AWS, GCP,
  // Hetzner, R2): they are the polished path most users need. The raw
  // bring-your-own-key env editor stays fully supported — any provider, no
  // allowlist / approval / billing — but as the quiet advanced path behind
  // openByokEditor below.
  const [provider, setProvider] = createSignal<string>(
    PROVIDERS[0]?.provider ?? GENERIC_ENV_PROVIDER_OPTION,
  );
  const [displayName, setDisplayName] = createSignal("");
  // Secret material lives ONLY for the lifetime of the form; cleared on submit.
  const [values, setValues] = createSignal<Record<string, string>>({});
  const [helperToken, setHelperToken] = createSignal("");
  const [helperCloudflareAccountId, setHelperCloudflareAccountId] =
    createSignal("");
  const [
    helperCloudflareWorkersSubdomain,
    setHelperCloudflareWorkersSubdomain,
  ] = createSignal("");
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
  const setupGuide = createMemo(() => descriptor()?.setupGuide);

  const setFieldValue = (envName: string, value: string) => {
    setValues((prev) => ({ ...prev, [envName]: value }));
  };
  const scopeHintsFromConnectionValues = (
    providerId: string,
    connectionValues: Readonly<Record<string, string>>,
  ):
    | {
        readonly accountId?: string;
        readonly workersSubdomain?: string;
        readonly awsRegion?: string;
        readonly gcpProjectId?: string;
      }
    | undefined => {
    if (providerId === "cloudflare") {
      const accountId = connectionValues.CLOUDFLARE_ACCOUNT_ID?.trim();
      return accountId ? { accountId } : undefined;
    }
    if (providerId === "aws" || providerId === "hashicorp/aws") {
      const awsRegion = connectionValues.AWS_REGION?.trim();
      return awsRegion ? { awsRegion } : undefined;
    }
    if (providerId === "gcp" || providerId === "google") {
      const gcpProjectId =
        connectionValues.GOOGLE_CLOUD_PROJECT?.trim() ||
        connectionValues.GOOGLE_PROJECT?.trim();
      return gcpProjectId ? { gcpProjectId } : undefined;
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
    setHelperCloudflareWorkersSubdomain("");
    setDisplayName("");
    setGenericEnvProvider("");
    setEnvPairs([{ name: "", value: "" }]);
  };

  // Quiet advanced path: switch the add flow to the raw BYOK env editor.
  // Dropping any half-entered secret values mirrors the provider switcher.
  const openByokEditor = () => {
    setProvider(GENERIC_ENV_PROVIDER_OPTION);
    setValues({});
    setHelperToken("");
    setGenericEnvProvider("");
    setEnvPairs([{ name: "", value: "" }]);
  };

  // ----- one-time URL result banner (OAuth backend callback) ---------------
  const [oauthNotice, setOauthNotice] = createSignal<
    { kind: "ok" } | { kind: "error"; code: string } | null
  >(null);
  const oauthErrorCode = (): string => {
    const notice = oauthNotice();
    return notice && notice.kind === "error" ? notice.code : "";
  };
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
    const workersSubdomain = helperCloudflareWorkersSubdomain().trim();
    const scopeHints = scopeHintsFromConnectionValues(
      d.providerSource ?? d.provider,
      submitValues,
    );
    const connection = await createConnection({
      workspaceId: workspaceId(),
      provider: d.providerSource ?? d.provider,
      displayName:
        displayName().trim() || (d.providerSource ? d.label : undefined),
      scopeHints:
        workersSubdomain && d.provider === "cloudflare"
          ? { ...(scopeHints ?? {}), workersSubdomain }
          : scopeHints,
      values: submitValues,
    });
    await afterConnectionCreated(connection);
    await runTest(connection.id);
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
      workspaceId: workspaceId(),
      provider: d.providerSource ?? d.provider,
      displayName:
        displayName().trim() || (d.providerSource ? d.label : undefined),
      scopeHints: scopeHintsFromConnectionValues(
        d.providerSource ?? d.provider,
        submitValues,
      ),
      values: submitValues,
    });
    await afterConnectionCreated(connection);
    await runTest(connection.id);
  });

  // Generic Provider Connection submit. This is the first-class path for any
  // provider not covered by a guided recipe.
  const createGenericEnvProvider = createAction(async () => {
    const name = genericEnvProvider().trim();
    if (!name) throw new Error(t("conn.genericEnv.providerRequired"));
    const submitValues: Record<string, string> = {};
    const seenEnvNames = new Set<string>();
    for (const pair of envPairs()) {
      const envName = pair.name.trim();
      const value = pair.value;
      if (envName.length === 0 && value.length === 0) continue;
      if (envName.length === 0) {
        throw new Error(t("conn.genericEnv.nameRequired"));
      }
      if (!isProviderEnvName(envName)) {
        throw new Error(t("conn.genericEnv.invalidName", { name: envName }));
      }
      if (isReservedProviderEnvName(envName)) {
        throw new Error(t("conn.genericEnv.reservedName", { name: envName }));
      }
      if (seenEnvNames.has(envName)) {
        throw new Error(t("conn.genericEnv.duplicateName", { name: envName }));
      }
      seenEnvNames.add(envName);
      submitValues[envName] = value;
    }
    if (Object.keys(submitValues).length === 0) {
      throw new Error(t("conn.genericEnv.oneRequired"));
    }
    const connection = await createConnection({
      workspaceId: workspaceId(),
      provider: name,
      kind: "generic_env_provider",
      displayName: displayName().trim() || undefined,
      values: submitValues,
    });
    await afterConnectionCreated(connection);
    await runTest(connection.id);
  });

  // Per-connection test / remove. Busy and error state are tracked PER
  // connection id — a single shared signal would let concurrent tests clear
  // each other's spinner and show whichever error finished last.
  const [testBusyIds, setTestBusyIds] = createSignal<ReadonlySet<string>>(
    new Set(),
  );
  interface TestFailure {
    readonly message: string;
    readonly detail?: string;
  }
  const [testErrors, setTestErrors] = createSignal<
    Readonly<Record<string, TestFailure>>
  >({});
  const testBusy = (id: string) => testBusyIds().has(id);
  const testError = (id: string) => testErrors()[id] ?? null;
  const setTestBusy = (id: string, busy: boolean) => {
    setTestBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const setTestError = (id: string, failure: TestFailure | null) => {
    setTestErrors((prev) => {
      const next = { ...prev };
      if (failure === null) delete next[id];
      else next[id] = failure;
      return next;
    });
  };

  const runTest = async (id: string) => {
    setTestBusy(id, true);
    setTestError(id, null);
    try {
      const result = (await testConnection(id)) as
        { readonly status?: string; readonly detail?: string } | undefined;
      await refreshConnections();
      // The verified hint belongs to the LAST-CREATED connection only: testing
      // some other row must not flip lastCreatedReady() (and with it the
      // install-return offer) for a connection that was never verified.
      const isLastCreated = lastCreatedConnectionId() === id;
      if (result?.status && result.status !== "verified") {
        if (isLastCreated) setLastCreatedVerifiedHint(false);
        // The primary sentence stays localized (the backend enum is mapped
        // through providerConnectionStatusLabel); the raw server detail is
        // supplementary reference text, never the headline.
        setTestError(id, {
          message: t("conn.test.notReady", {
            status: providerConnectionStatusLabel(result.status),
          }),
          detail: result.detail,
        });
      } else if (result?.status === "verified") {
        if (isLastCreated) setLastCreatedVerifiedHint(true);
      }
    } catch (e) {
      // Raw server / exception text (English internals, HTTP status) never
      // becomes the headline — friendlyError localizes it and the raw text
      // rides along as folded detail only.
      const friendly = friendlyError(e, t);
      setTestError(id, {
        message: friendly.message,
        detail: friendly.detail,
      });
    } finally {
      setTestBusy(id, false);
    }
  };

  // Which connection is being revoked — remove is one shared action, so
  // without this every row's delete button would look busy during a single
  // revoke (same per-row idiom as SharesTab/BackupsTab).
  const [removingId, setRemovingId] = createSignal<string | null>(null);
  const remove = createAction(async (id: string) => {
    setRemovingId(id);
    try {
      await revokeConnection(id);
      if (lastCreatedConnectionId() === id) {
        setLastCreatedConnectionId(null);
        setLastCreatedConnectionName(null);
        setLastCreatedVerifiedHint(false);
      }
      await refreshConnections();
    } finally {
      setRemovingId(null);
    }
  });

  const providerConnectionForConnectionId = (connectionId: string | null) =>
    providerConnectionRows().find(
      (connection) => connection.id === connectionId,
    );
  const lastCreatedProviderConnection = () =>
    providerConnectionForConnectionId(lastCreatedConnectionId());
  const lastCreatedReady = () =>
    lastCreatedProviderConnection()?.status === "verified" ||
    lastCreatedVerifiedHint();
  const shouldOfferInstallReturn = () =>
    !lastCreatedConnectionId() || lastCreatedReady();
  const confirmRemoveProviderConnection = async (
    connection: ProviderConnection,
  ) => {
    // Same name fallback as the list row: never a raw conn_… id, and an
    // empty-string displayName must not slip through `??` and render 「」.
    const name =
      connection.displayName || providerConnectionProviderLabel(connection);
    const ok = await confirm({
      title: t("conn.remove.confirmTitle"),
      // Warn that live Capsules' ProviderBindings referencing this connection
      // will fail their next Run (provider_connection_setup_required).
      message: `${t("conn.remove.confirmMessage", { name })} ${t(
        "conn.remove.bindingWarning",
      )}`,
      confirmText: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    void remove.run(connection.id);
  };

  const providerConnectionList = () => (
    <ul class="wc-conn-list">
      <For each={providerConnectionRows()}>
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
              <Show when={connection.expiresAt}>
                {(expiresAt) => (
                  <span>
                    {t("conn.expiresAt", {
                      date: formatDateTime(expiresAt()),
                    })}
                  </span>
                )}
              </Show>
            </div>
            <div class="wc-conn-actions">
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => void runTest(connection.id)}
                busy={testBusy(connection.id)}
              >
                {testBusy(connection.id) ? t("conn.testing") : t("conn.test")}
              </Button>
              <Button
                variant="danger"
                size="sm"
                type="button"
                onClick={() => void confirmRemoveProviderConnection(connection)}
                busy={remove.busy() && removingId() === connection.id}
                disabled={remove.busy()}
                icon={<Trash size={14} />}
              >
                {t("common.delete")}
              </Button>
            </div>
            <Show when={testError(connection.id)}>
              {(failure) => (
                <Toast tone="error">
                  {failure().message}
                  <Show when={failure().detail}>
                    {(detail) => (
                      <details class="wc-conn-test-detail">
                        <summary>{t("common.details")}</summary>
                        {detail()}
                      </details>
                    )}
                  </Show>
                </Toast>
              )}
            </Show>
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
              <Toast tone="error">
                <span class="wc-inline-feedback">
                  <span>
                    {oauthErrorHint(oauthErrorCode()) ?? t("conn.oauth.failed")}
                  </span>
                  <Show when={oauthErrorCode()}>
                    {(code) => (
                      <details class="wc-conn-test-detail">
                        <summary>{t("common.details")}</summary>
                        {t("conn.oauth.errorCode", { code: code() })}
                      </details>
                    )}
                  </Show>
                </span>
              </Toast>
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
            subtitle={t("conn.return.subtitle")}
            actions={
              <Show
                when={shouldOfferInstallReturn()}
                fallback={
                  <Show when={lastCreatedConnectionId()}>
                    {(id) => (
                      <Button
                        variant="secondary"
                        type="button"
                        busy={testBusy(id())}
                        onClick={() => void runTest(id())}
                      >
                        {testBusy(id())
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
                        busy={testBusy(id())}
                        onClick={() => void runTest(id())}
                      >
                        {testBusy(id())
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

      <Show when={providerConnectionRows().length > 0}>
        <div class="wc-stack-sm">
          <Show when={!createFormOpen()}>
            <div class="wc-card-action-row">
              <Button
                variant="primary"
                size="sm"
                type="button"
                icon={<Plus size={14} />}
                onClick={() => setCreateFormOpen(true)}
              >
                {t("conn.add.open")}
              </Button>
            </div>
          </Show>
          <ActionError error={remove.error} />
          {providerConnectionList()}
        </div>
      </Show>
      <Show
        when={
          !providerConnections.loading &&
          !providerConnections.error &&
          !hasProviderConnections() &&
          !createFormOpen()
        }
      >
        <EmptyState
          icon={<Plug size={28} />}
          title={t("conn.empty.title")}
          message={t("conn.empty.message")}
          action={
            <Button
              variant="primary"
              type="button"
              icon={<Plus size={16} />}
              onClick={() => setCreateFormOpen(true)}
            >
              {t("conn.add.open")}
            </Button>
          }
        />
      </Show>
      <Show when={providerConnections.error}>
        {(error) => {
          const friendly = friendlyError(error(), t);
          return (
            <Toast tone="error">
              <span class="wc-inline-feedback">
                <span>{friendly.message}</span>
                <Show when={friendly.detail}>
                  {(detail) => (
                    <details class="wc-conn-test-detail">
                      <summary>{t("common.details")}</summary>
                      {detail()}
                    </details>
                  )}
                </Show>
              </span>
            </Toast>
          );
        }}
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
            <Show when={!isGenericEnvProvider()}>
              {/* Guided presets are the default surface: pick a provider and
                  follow its pre-scoped token flow. The raw BYOK env editor is
                  the advanced path behind the quiet control at the bottom. */}
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
            </Show>

            <details class="connection-advanced">
              <summary>{t("conn.add.optionalSettings")}</summary>
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
            </details>

            <Show
              when={isGenericEnvProvider()}
              fallback={
                <Show
                  when={tokenHelper()}
                  fallback={
                    <>
                      <Show when={setupGuide()}>
                        {(guide) => (
                          <div class="wc-guided">
                            <div class="wc-form-actions">
                              <Button
                                variant="secondary"
                                href={guide().url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {t("conn.guided.openProvider", {
                                  provider: descriptor()?.label ?? "",
                                })}
                              </Button>
                            </div>
                            <details class="connection-instructions">
                              <summary>{t("conn.guided.instructions")}</summary>
                              <ol class="wc-steps">
                                <For each={guide().steps}>
                                  {(s) => <li>{s}</li>}
                                </For>
                              </ol>
                            </details>
                          </div>
                        )}
                      </Show>
                      <details
                        class="connection-advanced connection-help"
                        open={Boolean(setupGuide())}
                      >
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
                      </details>
                    </>
                  }
                >
                  {(helper) => (
                    <>
                      <div class="wc-guided">
                        <details
                          class="connection-advanced connection-help"
                          open
                        >
                          <summary>{t("conn.guided.stepsSummary")}</summary>
                          <div class="wc-form-actions">
                            <Button
                              variant="secondary"
                              href={helper().createTokenUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {t("conn.guided.openProvider", {
                                provider: descriptor()?.label ?? "",
                              })}
                            </Button>
                          </div>
                          <details class="connection-instructions">
                            <summary>{t("conn.guided.instructions")}</summary>
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
                            <Show
                              when={descriptor()?.provider === "cloudflare"}
                            >
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
                              <FormField
                                label={t(
                                  "conn.provider.cloudflare.workersSubdomain.label",
                                )}
                              >
                                <Input
                                  id="connection-helper-cloudflare-workers-subdomain"
                                  name="helperCloudflareWorkersSubdomain"
                                  type="text"
                                  value={helperCloudflareWorkersSubdomain()}
                                  onInput={(e) =>
                                    setHelperCloudflareWorkersSubdomain(
                                      e.currentTarget.value,
                                    )
                                  }
                                  placeholder={t(
                                    "conn.provider.cloudflare.workersSubdomain.placeholder",
                                  )}
                                  autocomplete="off"
                                  spellcheck={false}
                                />
                              </FormField>
                            </Show>
                            <div class="wc-form-actions">
                              <Button
                                variant="secondary"
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
                        </details>
                      </div>
                    </>
                  )}
                </Show>
              }
            >
              {/* Advanced bring-your-own-key editor: any OpenTofu provider,
                  no allowlist / approval / billing. h2 keeps the heading
                  hierarchy flat under the page h1, like sibling sections. */}
              <div class="wc-guided">
                <div class="wc-byok-intro">
                  <h2 class="wc-byok-title">{t("conn.byok.title")}</h2>
                  <p class="muted">{t("conn.byok.body")}</p>
                  <p class="wc-byok-note">{t("conn.byok.noBillingNote")}</p>
                </div>
                <div class="wc-form-actions">
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => {
                      setProvider(PROVIDERS[0]?.provider ?? "");
                      setGenericEnvProvider("");
                      setEnvPairs([{ name: "", value: "" }]);
                    }}
                  >
                    {t("conn.byok.usePreset")}
                  </Button>
                </div>
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
                      placeholder={t("conn.genericEnv.providerPlaceholder")}
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
                            placeholder={t(
                              "conn.genericEnv.envNamePlaceholder",
                            )}
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

            <Show when={!isGenericEnvProvider()}>
              {/* Quiet advanced entry: providers without a preset connect via
                  the raw BYOK env editor. */}
              <div class="wc-form-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={openByokEditor}
                >
                  {t("conn.add.genericEnvOption")}
                </Button>
              </div>
            </Show>
          </div>
        </Card>
      </Show>

      {/* First-load skeleton only — refetch after create/test/revoke keeps the
          list rendered instead of flashing two skeleton cards each time. */}
      <Show when={providerConnections.loading && !providerConnections.latest}>
        <Skeleton variant="card" count={2} />
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
