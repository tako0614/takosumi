/**
 * 接続 — the behavior "connect my cloud". Lists personal connections at /connections
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
import { A, useLocation } from "@solidjs/router";
import { ArrowLeft, ChevronRight, Plug, Plus, RefreshCw } from "lucide-solid";
import type { CredentialRecipe } from "takosumi-contract";
import { credentialRecipePresentationText } from "../../account/lib/api.ts";
import { ActionError, createAction } from "../../account/lib/action.tsx";
import { currentSessionCheck } from "../../account/lib/session.ts";
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
  appOwnershipAvailable,
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
  EmptyState,
  Skeleton,
  Toast,
} from "../../../components/ui/index.ts";
import ConnectionCreateForm from "../connections/ConnectionCreateForm.tsx";
import { appPageHref, uninstallReturnHref } from "../../../lib/app-links.ts";
import { isUninstallReplacementReady } from "../../../lib/capsule-uninstall.ts";
import { currentWorkspaceId } from "../../../lib/workspace-state.ts";

const INSTALL_RETURN_STORAGE_KEY = "takosumi.dashboard.installReturn";
const PERSONAL_CONNECTION_USAGE_SOURCE = "personal";

interface ConnectionListScope {
  readonly workspaceId?: string;
}

interface ConnectionListSnapshot {
  readonly scope: ConnectionListScope;
  readonly sessionIsCurrent: () => boolean;
  readonly connections: readonly ProviderConnection[];
}

function providerConnectionProviderLabel(
  connection: ProviderConnection,
  recipes: readonly CredentialRecipe[],
  language: string,
): string {
  const binding = connection.credentialRecipe;
  const recipe = binding && recipes.find((entry) =>
    entry.id === binding.id && entry.secretPartition === binding.secretPartition &&
    (entry.terraformSource === "*" || entry.terraformSource.includes(connection.providerSource)));
  const provider = recipe?.displayName ?? readableProviderSourceLabel(connection.providerSource);
  const methodLabel = credentialRecipePresentationText(
    binding ? recipe?.authModes[binding.authMode]?.presentation?.displayName : undefined,
    language,
  ) ?? (binding?.authMode === "oauth" || connection.materialization === "oauth" ? "OAuth" : undefined);
  return methodLabel ? `${provider} — ${methodLabel}` : provider;
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
  const connectionListWorkspaceId = () => workspaceId() || currentWorkspaceId() || undefined;
  const connectionListScope = createMemo((): ConnectionListScope => ({ workspaceId: connectionListWorkspaceId() }));
  const requests = new AbortController();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    requests.abort();
  });

  const [providerConnections, { refetch: refetchProviderConnections }] =
    createResource<ConnectionListSnapshot, ConnectionListScope, () => boolean>(
      connectionListScope,
      async (scope, { refetching }) => {
        const sessionIsCurrent = currentSessionCheck();
        const connections = await listProviderConnections(scope.workspaceId, typeof refetching === "function"
          ? { cache: "no-store", signal: requests.signal, isCurrent: refetching }
          : undefined);
        return { scope, sessionIsCurrent, connections };
      },
    );
  const [credentialRecipes] = createResource(connectionSetupCatalog);
  // Personal ownership is authoritative. The selected legacy workspace is
  // only a fallback if the new /apps endpoint is missing.
  // Which owner apps use each connection. Not read inside the install review.
  const [usage, { refetch: refetchUsage }] = createResource(
    () => {
      if (props.embedded) return null;
      const id = connectionListWorkspaceId();
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
  const providerLabel = (connection: ProviderConnection) =>
    providerConnectionProviderLabel(connection, installedCredentialRecipes(), locale());
  const [createdConnectionName, setLastCreatedConnectionName] =
    createSignal<string | null>(null);
  const [createdConnectionId, setLastCreatedConnectionId] = createSignal<
    string | null
  >(null);
  const [createdConnectionOwner, setCreatedConnectionOwner] =
    createSignal<() => boolean>();
  const lastCreatedConnectionId = () => createdConnectionOwner()?.() ? createdConnectionId() : null;
  const lastCreatedConnectionName = () => createdConnectionOwner()?.() ? createdConnectionName() : null;
  const [lastCreatedVerifiedHint, setLastCreatedVerifiedHint] =
    createSignal(false);
  const [reverifiedUninstallConnectionIds, setReverifiedUninstallConnectionIds] =
    createSignal<ReadonlySet<string>>(new Set());
  const location = useLocation();
  const currentUninstallReturn = () => props.embedded ? undefined : uninstallReturnHref(location.search);
  const uninstallReturn = currentUninstallReturn();
  const inUninstallReturnContext = () => uninstallReturn !== undefined &&
    currentUninstallReturn() === uninstallReturn;
  const installReturn = props.embedded || uninstallReturn ? undefined : currentInstallReturnContext();
  const [createFormOpen, setCreateFormOpen] = createSignal(
    Boolean(installReturn || uninstallReturn || props.embedded),
  );
  let settingsList!: HTMLDivElement;
  const openCreateForm = () => {
    setCreateFormOpen(true);
    requestAnimationFrame(() => {
      const field = settingsList.querySelector<HTMLElement>(
        "#connection-provider, #connection-display-name",
      );
      field?.focus();
    });
  };
  const closeCreateForm = () => {
    setCreateFormOpen(false);
    requestAnimationFrame(() => {
      settingsList.querySelector<HTMLElement>("[data-add-connection]")?.focus();
    });
  };
  // An errored resource THROWS on read; every data read goes through this
  // guarded accessor so a failed list surfaces the error toast below instead
  // of crashing the tab.
  const currentConnectionList = () => {
    const latest = providerConnections.error ? undefined : providerConnections.latest;
    if (latest?.scope === connectionListScope() && latest.sessionIsCurrent()) return latest;
  };
  const providerConnectionRows = () => currentConnectionList()?.connections ?? [];
  const hasProviderConnections = () => providerConnectionRows().length > 0;
  const shouldShowCreateForm = () => createFormOpen();

  const refreshConnections = async (isCurrent?: () => boolean) => {
    await refetchProviderConnections(isCurrent);
    if (!disposed && (isCurrent?.() ?? true)) props.onChanged?.();
  };
  const appNames = (apps: readonly ConnectionAppRef[]) =>
    apps.map((app) => app.name).join(locale() === "ja" ? "、" : ", ");

  const afterConnectionCreated = async (connection: ProviderConnection) => {
    const isCurrent = currentConnectionOwner();
    const workspace = await appOwnershipAvailable() ? undefined : workspaceId() ?? (currentWorkspaceId() || undefined);
    const matchesScope = workspace
      ? connection.workspaceId === workspace
      : connection.scope !== "operator";
    if (!isCurrent() || !matchesScope) return;
    // Never show a raw conn_… id in the toast — fall back to the provider name.
    setLastCreatedConnectionName(providerConnectionDisplayName(connection) || providerLabel(connection));
    setLastCreatedConnectionId(connection.id);
    setCreatedConnectionOwner(() => isCurrent);
    setLastCreatedVerifiedHint(false);
    await refreshConnections(isCurrent);
    if (isCurrent() && !installReturn) closeCreateForm();
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
        setCreatedConnectionOwner(() => currentConnectionOwner());
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

  function currentConnectionOwner(): () => boolean {
    const scope = connectionListScope();
    const sessionIsCurrent = currentSessionCheck();
    return () => !disposed && sessionIsCurrent() && connectionListScope() === scope;
  }

  const runTest = async (id: string) => {
    if (disposed || testBusy(id) ||
      (!providerConnectionForConnectionId(id) &&
        !(lastCreatedConnectionId() === id && lastCreatedConnectionName()))) return;
    const isCurrent = currentConnectionOwner();
    const fromUninstall = inUninstallReturnContext();
    setReverifiedUninstallConnectionIds((ids) => {
      if (!ids.has(id)) return ids;
      const next = new Set(ids);
      next.delete(id);
      return next;
    });
    setTestBusy(id, true);
    setTestError(id, null);
    try {
      const result = await testConnection(id, { signal: requests.signal, isCurrent });
      if (!isCurrent()) return;
      if (result.status === "unconfirmed") {
        setTestError(id, { message: t("conn.test.unconfirmed") });
        // A fresh list shows the current status, but does not acknowledge
        // this verification or complete an uninstall handoff.
        await refreshConnections(isCurrent).catch(() => {});
        return;
      }
      await refreshConnections(isCurrent);
      if (!isCurrent()) return;
      // The verified hint belongs to the LAST-CREATED connection only: testing
      // some other row must not flip lastCreatedReady() (and with it the
      // install-return offer) for a connection that was never verified.
      const isLastCreated = lastCreatedConnectionId() === id;
      if (result.status !== "verified") {
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
      } else {
        if (isLastCreated) setLastCreatedVerifiedHint(true);
        if (!disposed && fromUninstall && inUninstallReturnContext()) {
          setReverifiedUninstallConnectionIds((ids) => new Set(ids).add(id));
        }
      }
    } catch (e) {
      if (!isCurrent()) return;
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
  const [removalScope, setRemovalScope] = createSignal<() => boolean>();
  const [removalUnconfirmed, setRemovalUnconfirmed] = createSignal(false);
  const remove = createAction(async (id: string, isCurrent: () => boolean) => {
    setRemovingId(id);
    setRemovalScope(() => isCurrent);
    setRemovalUnconfirmed(false);
    try {
      const outcome = await revokeConnection(id, { signal: requests.signal, isCurrent });
      if (!isCurrent()) return;
      setRemovalUnconfirmed(outcome === "unconfirmed");
      if (lastCreatedConnectionId() === id) {
        setLastCreatedConnectionId(null);
        setLastCreatedConnectionName(null);
        setLastCreatedVerifiedHint(false);
      }
      // The list represents current visibility. An absent row is not a
      // receipt for this POST, so keep the unconfirmed notice when needed.
      await refetchProviderConnections(isCurrent);
      if (!isCurrent()) return;
      props.onChanged?.();
      if (!props.embedded) void refetchUsage();
    } catch (error) {
      if (isCurrent()) throw error;
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
  const verifiedUninstallReturn = () => {
    // The router retains this component when only the search changes. Keep
    // the verified result attached to the original app's return context.
    if (!inUninstallReturnContext() || providerConnections.state !== "ready") return;
    const ready = (id: string | null | undefined) => {
      if (!id || testBusy(id) || testError(id)) return false;
      const connection = providerConnectionForConnectionId(id);
      return connection !== undefined && isUninstallReplacementReady(connection);
    };
    if ([...reverifiedUninstallConnectionIds()].some(ready) ||
      (lastCreatedConnectionName() && ready(lastCreatedConnectionId()))) return uninstallReturn;
  };
  const lastCreatedReady = () =>
    lastCreatedProviderConnection()?.status === "verified" ||
    (lastCreatedConnectionId() !== null && lastCreatedVerifiedHint());
  const shouldOfferInstallReturn = () =>
    !lastCreatedConnectionId() || lastCreatedReady();
  const confirmRemoveProviderConnection = async (
    connection: ProviderConnection,
  ) => {
    const displayedList = currentConnectionList();
    if (!displayedList?.connections.includes(connection)) return;
    const isCurrent = () => !disposed && displayedList.sessionIsCurrent() && displayedList.scope === connectionListScope();
    // Same name fallback as the list row: never a raw conn_… id, and an
    // empty-string displayName must not slip through `??` and render 「」.
    const name =
      providerConnectionDisplayName(connection) ||
      providerLabel(connection);
    const apps = appsUsing(connection.id);
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
    if (!ok || !isCurrent() || remove.busy() || !providerConnectionForConnectionId(connection.id)) return;
    void remove.run(connection.id, isCurrent);
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

  const connectionById = createMemo(() =>
    new Map(providerConnectionRows().map((connection) => [connection.id, connection])),
  );
  const connectionIds = () => providerConnectionRows().map((connection) => connection.id);
  // A test refreshes the data. Key the rows by ID so it doesn't collapse an
  // open disclosure or replace its controls with new DOM elements.
  const providerConnectionList = () => (
    <ul class="conn-list tg-settings-group">
      <For each={connectionIds()}>
        {(id) => (
          <Show when={connectionById().get(id)}>
            {(connection) => {
              const provider = () => providerLabel(connection());
              const displayName = () => providerConnectionDisplayName(connection()) || provider();
              return (
                <li class="tg-settings-list-item">
                  <details class="conn-details">
                    <summary class="tg-settings-row tg-settings-link">
                      <span class="tg-settings-symbol"><Plug size={17} aria-hidden="true" /></span>
                      <span class="tg-settings-row-text">
                        <strong class="tg-settings-label">{displayName()}</strong>
                        <Show when={displayName() !== provider()}>
                          <span class="tg-settings-note">{provider()}</span>
                        </Show>
                      </span>
                      <Badge tone={providerConnectionTone(connection().status)}>
                        {providerConnectionStatusLabel(connection().status)}
                      </Badge>
                      <ChevronRight class="conn-chevron" size={16} aria-hidden="true" />
                    </summary>
                    <div class="conn-detail-body">
                      <Show when={connection().scope === "operator" || connection().expiresAt}>
                        <div class="conn-card-meta">
                          <Show when={connection().scope === "operator"}>
                            <span>{t("conn.operatorProvided")}</span>
                          </Show>
                          <Show when={connection().expiresAt}>
                            {(expiresAt) => (
                              <time datetime={expiresAt()} title={formatDateTime(expiresAt())}>
                                {t("conn.expiresAt", { date: formatDate(expiresAt()) })}
                              </time>
                            )}
                          </Show>
                        </div>
                      </Show>
                      {usageLine(connection())}
                      <div class="tg-settings-actions">
                        <Button
                          variant="secondary"
                          size="sm"
                          type="button"
                          onClick={() => void runTest(id)}
                          busy={testBusy(id)}
                        >
                          {testBusy(id) ? t("conn.testing") : t("conn.test")}
                        </Button>
                        <Show when={removable(connection())}>
                          <Button
                            variant="ghost"
                            size="sm"
                            type="button"
                            class="conn-remove"
                            onClick={() => void confirmRemoveProviderConnection(connection())}
                            busy={remove.busy() && removingId() === id}
                            disabled={remove.busy()}
                          >
                            {t("conn.remove.cta")}
                          </Button>
                        </Show>
                      </div>
                    </div>
                  </details>
                  <Show when={testError(id)}>
                    {(failure) => (
                      <div class="conn-row-feedback">
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
                      </div>
                    )}
                  </Show>
                </li>
              );
            }}
          </Show>
        )}
      </For>
    </ul>
  );

  return (
    <div class="wc-stack" ref={settingsList}>
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

      <Show when={installReturnHref}>
        {(href) => (
          <div class="tg-settings-group">
            <div class="tg-settings-row tg-settings-row-wrap">
              <Show when={installReturn?.label}>
                {(name) => <span class="tg-settings-label">{t("conn.return.title", { name: name() })}</span>}
              </Show>
              <Show
                when={shouldOfferInstallReturn()}
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
                        {testBusy(id()) ? t("conn.testing") : t("conn.saved.testCta")}
                      </Button>
                    )}
                  </Show>
                }
              >
                <Button
                  variant="ghost"
                  size="sm"
                  href={href()}
                  icon={<ArrowLeft size={16} />}
                  onClick={clearStoredInstallReturn}
                >
                  {lastCreatedConnectionId()
                    ? t("conn.saved.returnCta")
                    : t("conn.return.cta")}
                </Button>
              </Show>
            </div>
          </div>
        )}
      </Show>

      <Show when={lastCreatedConnectionName()}>
        {(name) => (
          <Toast tone={lastCreatedReady() ? "success" : "neutral"}>
            {t(lastCreatedReady() || !installReturnHref ? "conn.saved.message" : "conn.saved.needsTest", {
              name: name(),
            })}
          </Toast>
        )}
      </Show>

      <Show when={currentUninstallReturn()}>
        {(href) => (
          <div class="conn-add-action">
            <Button variant="secondary" href={href()} icon={<ArrowLeft size={16} />}>
              {t(verifiedUninstallReturn() ? "conn.uninstall.returnCta" : "conn.uninstall.backToApp")}
            </Button>
          </div>
        )}
      </Show>

      <Show when={hasProviderConnections() && !createFormOpen()}>
        <div class="conn-add-action">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            icon={<Plus size={16} />}
            data-add-connection
            onClick={openCreateForm}
          >
            {t("conn.add.open")}
          </Button>
        </div>
      </Show>
      {/* ----- register form ----- */}
      <ConnectionCreateForm
        open={shouldShowCreateForm()}
        settingsAppearance={!props.embedded}
        workspaceId={workspaceId()}
        setupCatalog={credentialRecipes}
        initialProviderSource={props.initialProviderSource}
        onCreated={afterConnectionCreated}
        verifyConnection={verifyCreatedConnection}
        onCancel={
          !props.embedded || hasProviderConnections()
            ? closeCreateForm
            : undefined
        }
      />

      <Show when={removalScope()?.()}>
        <ActionError error={remove.error} />
        <Show when={removalUnconfirmed()}>
          <Toast tone="neutral" onDismiss={() => setRemovalUnconfirmed(false)}>
            {t("conn.remove.unconfirmed")}
          </Toast>
        </Show>
      </Show>
      <Show when={hasProviderConnections()}>
        {providerConnectionList()}
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
              data-add-connection
              onClick={openCreateForm}
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

      {/* First-load skeleton only — refetch after create/test/revoke keeps the
          list rendered instead of flashing two skeleton cards each time. */}
      <Show when={providerConnections.loading && !currentConnectionList()}>
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
