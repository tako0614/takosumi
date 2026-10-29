/**
 * 接続 — the behavior "connect my cloud". Lists personal connections in Account
 * (or workspace connections in the retained embedded surface) on the
 * session-authed control surface (`/api/v1/connections*`), and for each one
 * shows which installed apps use it, a test, and removal that names the
 * affected apps. The create form (guided recipe fields, provider OAuth popup,
 * or keys for a cloud without a guided method) lives in
 * ../connections/ConnectionCreateForm.tsx; this component owns the list, the
 * per-connection test / remove state, and the first test of each connection
 * the form saves.
 *
 * Which apps use a connection is derived from each app's provider bindings
 * (lib/connection-usage.ts). The install review embeds this component with
 * `embedded` and skips that read: there the question is which connection to
 * pick, not who already uses it.
 *
 * A credential OAuth callback redirects to `/connections?connected=1` plus an
 * opaque `connection_id` / `connection_status`, which the router forwards here
 * query-intact; the one-time banner reads and strips those params. `/new` links
 * may also include a safe `return=/new?...` target so users can create a
 * connection, then jump back to the install.
 */
import "../../../styles/wave-c.css";
import {
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { A } from "@solidjs/router";
import { ArrowLeft, Plug, Plus, RefreshCw } from "lucide-solid";
import {
  providerSetupOptionsFromCredentialRecipes,
  type ProviderConnectionSetupOption,
} from "../../account/lib/api.ts";
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
  type ProviderConnection,
  connectionSetupCatalog,
  listProviderConnections,
  revokeConnection,
  testConnection,
} from "../../../lib/control-api.ts";
import { readableProviderSourceLabel } from "../../../lib/provider-labels.ts";
import { providerConnectionDisplayName } from "../../../lib/provider-connections.ts";
import {
  type ConnectionAppRef,
  loadConnectionUsage,
} from "../../../lib/connection-usage.ts";
import { formatDate, formatDateTime, locale, t } from "../../../i18n/index.ts";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Skeleton,
  Toast,
} from "../../../components/ui/index.ts";
import ConnectionCreateForm from "../connections/ConnectionCreateForm.tsx";
import { appPageHref } from "../../../lib/app-links.ts";
import { currentWorkspaceId } from "../../../lib/workspace-state.ts";

const INSTALL_RETURN_STORAGE_KEY = "takosumi.dashboard.installReturn";
const PERSONAL_CONNECTION_USAGE_SOURCE = "personal";

function providerConnectionProviderLabel(
  connection: ProviderConnection,
  options: readonly ProviderConnectionSetupOption[],
): string {
  const recipe = connection.credentialRecipe;
  const exact = options.find(
    (option) =>
      (recipe
        ? option.credentialRecipe.id === recipe.id &&
          option.credentialRecipe.authMode === recipe.authMode
        : false) ||
      option.providerSource === connection.providerSource ||
      option.providerAliases.includes(connection.providerSource),
  );
  return exact?.label ?? readableProviderSourceLabel(connection.providerSource);
}

/**
 * Maps a provider-owned OAuth callback failure code (`missing_code` /
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
  /** Omitted on the personal Account > Connections page. */
  readonly workspaceId?: string;
  readonly embedded?: boolean;
  readonly initialProviderSource?: string;
  readonly onChanged?: () => void;
}) {
  const { confirm } = useConfirmDialog();
  const workspaceId = () => props.workspaceId;
  let disposed = false;
  onCleanup(() => { disposed = true; });

  const [providerConnections, { refetch: refetchProviderConnections }] =
    createResource(
      () => ({ workspaceId: workspaceId() }),
      ({ workspaceId: id }) => listProviderConnections(id || currentWorkspaceId() || undefined),
    );
  const [credentialRecipes] = createResource(connectionSetupCatalog);
  // Personal ownership is authoritative. The selected legacy workspace is
  // only a fallback if the new /apps endpoint is missing.
  const legacyUsageWorkspaceId = () => workspaceId() || currentWorkspaceId() || undefined;
  // Which owner apps use each connection. Not read inside the install review.
  const [usage, { refetch: refetchUsage }] = createResource(
    () => {
      if (props.embedded) return null;
      const id = legacyUsageWorkspaceId();
      return id ? `legacy:${id}` : PERSONAL_CONNECTION_USAGE_SOURCE;
    },
    (source) => loadConnectionUsage(
      source === PERSONAL_CONNECTION_USAGE_SOURCE ? undefined : source.slice("legacy:".length),
    ),
  );
  /** Apps using the connection; `undefined` while unknown. */
  const appsUsing = (
    connectionId: string,
  ): readonly ConnectionAppRef[] | undefined => {
    if (props.embedded || usage.loading || usage.error) return undefined;
    const known = usage.latest;
    if (!known) return undefined;
    // Removal confirmation must not present a partial list as complete.
    if (known.incomplete) return undefined;
    const apps = known.appsByConnection.get(connectionId) ?? [];
    return apps;
  };
  const installedCredentialRecipes = () =>
    credentialRecipes.error ? [] : (credentialRecipes.latest?.recipes ?? []);
  const providerOptions = createMemo(() =>
    providerSetupOptionsFromCredentialRecipes(
      installedCredentialRecipes(),
      locale(),
    ),
  );
  const [lastCreatedConnectionName, setLastCreatedConnectionName] =
    createSignal<string | null>(null);
  const [lastCreatedConnectionId, setLastCreatedConnectionId] = createSignal<
    string | null
  >(null);
  const [lastCreatedVerifiedHint, setLastCreatedVerifiedHint] =
    createSignal(false);
  const installReturn = props.embedded ? undefined : currentInstallReturnContext();
  const [createFormOpen, setCreateFormOpen] = createSignal(
    Boolean(installReturn) || Boolean(props.embedded),
  );
  // An errored resource THROWS on read; every data read goes through this
  // guarded accessor so a failed list surfaces the error toast below instead
  // of crashing the tab.
  const providerConnectionRows = (): readonly ProviderConnection[] =>
    providerConnections.error ? [] : (providerConnections.latest ?? []);
  const hasProviderConnections = () => providerConnectionRows().length > 0;
  const shouldShowCreateForm = () => createFormOpen();

  const refreshConnections = async () => {
    await refetchProviderConnections();
    if (!disposed) props.onChanged?.();
  };
  const appNames = (apps: readonly ConnectionAppRef[]) =>
    apps.map((app) => app.name).join(locale() === "ja" ? "、" : ", ");

  const afterConnectionCreated = async (connection: ProviderConnection) => {
    const workspace = workspaceId();
    const matchesScope = workspace
      ? connection.workspaceId === workspace
      : connection.scope !== "operator";
    if (disposed || !matchesScope) return;
    // Never show a raw conn_… id in the toast — fall back to the provider name.
    setLastCreatedConnectionName(
      providerConnectionDisplayName(connection) ||
        providerOptions().find(
          (candidate) =>
            candidate.providerSource === connection.providerSource ||
            candidate.providerAliases.includes(connection.providerSource),
        )?.label ||
        readableProviderSourceLabel(connection.providerSource),
    );
    setLastCreatedConnectionId(connection.id);
    setLastCreatedVerifiedHint(false);
    await refreshConnections();
    if (!installReturn) setCreateFormOpen(false);
  };
  const installReturnHref = installReturn
    ? installReturnPathFromContext(installReturn)
    : undefined;

  // ----- one-time URL result banner (OAuth backend callback) ---------------
  const [oauthNotice, setOauthNotice] = createSignal<
    { kind: "ok" } | { kind: "error"; code: string } | null
  >(null);
  const oauthErrorCode = (): string => {
    const notice = oauthNotice();
    return notice && notice.kind === "error" ? notice.code : "";
  };
  if (!props.embedded && typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const flow = params.get("connection_flow");
    if (flow && /^sha256:[a-f0-9]{64}$/u.test(flow)) {
      const channel = new BroadcastChannel(`takosumi.oauth.${flow}`);
      channel.postMessage({ kind: "connection-oauth", error: params.has("connection_error"),
        connectionId: params.get("connection_id"), connectionStatus: params.get("connection_status") });
      setTimeout(() => channel.close(), 200);
    }
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
      params.delete("connection_flow");
      const next = params.toString();
      window.history.replaceState(
        {},
        "",
        window.location.pathname + (next ? `?${next}` : ""),
      );
    }
  }

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
  // The first test of a connection the form just saved. The form calls this
  // even after it closed itself; only an unmounted tab skips it.
  const verifyCreatedConnection = async (id: string) => {
    if (!disposed) await runTest(id);
  };

  // Which connection is being revoked — remove is one shared action, so
  // without this every row's delete button would look busy during a single
  // revoke.
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
      if (!props.embedded && !disposed) void refetchUsage();
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
      providerConnectionDisplayName(connection) ||
      providerConnectionProviderLabel(connection, providerOptions());
    const apps = appsUsing(connection.id);
    // The consequence is stated with the apps it affects: their next update,
    // settings change or uninstall needs another connection. Removing never
    // deletes what the apps created.
    const consequence =
      apps === undefined
        ? t("conn.remove.appsUnknown")
        : apps.length === 0
          ? t("conn.remove.noApps")
          : t("conn.remove.affectsApps", { apps: appNames(apps) });
    const ok = await confirm({
      title: t("conn.remove.confirmTitle", { name }),
      message: `${consequence} ${t("conn.remove.keepsResources")}`,
      confirmText: t("conn.remove.confirm"),
      danger: true,
    });
    if (!ok) return;
    void remove.run(connection.id);
  };

  /** Personal/workspace connections can be removed; operator-provided ones cannot. */
  const removable = (connection: ProviderConnection) =>
    connection.scope !== "operator";

  const usageLine = (connection: ProviderConnection) => (
    <Show when={!props.embedded}>
      <div class="conn-apps">
        <span class="conn-apps-label">{t("conn.apps.label")}</span>
        <Switch>
          <Match when={usage.loading && !usage.latest}>
            <span class="muted">{t("conn.apps.loading")}</span>
          </Match>
          <Match when={appsUsing(connection.id)}>
            {(apps) => (
              <Show
                when={apps().length > 0}
                fallback={<span class="muted">{t("conn.apps.none")}</span>}
              >
                <ul class="conn-apps-list">
                  <For each={apps()}>
                    {(app) => (
                      <li>
                        <A href={appPageHref(app.capsuleId)}>
                          {app.name}
                        </A>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            )}
          </Match>
          <Match when>
            <span class="muted">{t("conn.apps.unknown")}</span>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              icon={<RefreshCw size={14} />}
              busy={usage.loading}
              onClick={() => void refetchUsage()}
            >
              {t("common.retry")}
            </Button>
          </Match>
        </Switch>
      </div>
    </Show>
  );

  const providerConnectionList = () => (
    <ul class="conn-list">
      <For each={providerConnectionRows()}>
        {(connection) => (
          <li class="conn-card tg-card">
            <div class="conn-card-head">
              <span class="conn-card-name">
                {providerConnectionDisplayName(connection) ||
                  providerConnectionProviderLabel(
                    connection,
                    providerOptions(),
                  )}
              </span>
              <Badge tone={providerConnectionTone(connection.status)}>
                {providerConnectionStatusLabel(connection.status)}
              </Badge>
            </div>
            <div class="conn-card-meta">
              <span>
                {providerConnectionProviderLabel(
                  connection,
                  providerOptions(),
                )}
              </span>
              <Show when={connection.scope === "operator"}>
                <span>{t("conn.operatorProvided")}</span>
              </Show>
              <Show when={connection.expiresAt}>
                {(expiresAt) => (
                  <span title={formatDateTime(expiresAt())}>
                    {t("conn.expiresAt", { date: formatDate(expiresAt()) })}
                  </span>
                )}
              </Show>
            </div>
            {usageLine(connection)}
            <div class="conn-card-actions">
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => void runTest(connection.id)}
                busy={testBusy(connection.id)}
              >
                {testBusy(connection.id) ? t("conn.testing") : t("conn.test")}
              </Button>
              <Show when={removable(connection)}>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  class="conn-remove"
                  onClick={() => void confirmRemoveProviderConnection(connection)}
                  busy={remove.busy() && removingId() === connection.id}
                  disabled={remove.busy()}
                >
                  {t("conn.remove.cta")}
                </Button>
              </Show>
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
      {/* Result banner from a credential OAuth backend callback redirect. */}
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
                variant="secondary"
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
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  busy={providerConnections.loading}
                  onClick={() => void refetchProviderConnections()}
                >
                  {t("common.retry")}
                </Button>
              </span>
            </Toast>
          );
        }}
      </Show>

      {/* ----- register form ----- */}
      <ConnectionCreateForm
        open={shouldShowCreateForm()}
        workspaceId={workspaceId() || currentWorkspaceId() || undefined}
        setupCatalog={credentialRecipes}
        initialProviderSource={props.initialProviderSource}
        onCreated={afterConnectionCreated}
        verifyConnection={verifyCreatedConnection}
        onCancel={
          hasProviderConnections() ? () => setCreateFormOpen(false) : undefined
        }
      />

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
