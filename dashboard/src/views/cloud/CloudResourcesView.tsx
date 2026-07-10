/**
 * Cloud resources (`/cloud`) — Takosumi Cloud only. This screen treats managed
 * resource families as peers: current-month usage/cost first, then detailed
 * inventory operations. Cloud API keys live on the dedicated Workspace settings
 * keys tab; endpoint reference material stays in docs.
 */
import "../../styles/wave-c.css";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import type { JSX } from "solid-js";
import {
  Activity,
  CheckCircle2,
  Cloud,
  Copy,
  Database,
  HardDrive,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-solid";
import AuthGuard from "../account/components/auth/AuthGuard.tsx";
import {
  dashboardProductName,
  isTakosumiCloudRuntime,
} from "../../lib/deployment-brand.ts";
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";
import {
  type CloudflareResourceKind,
  type ProviderCompatCloudflareWorkersInventory,
  type CloudRequestContext,
  type CloudResourceResult,
  type CloudResourceUsageDisplayRow,
  type CloudResourceUsageQuantity,
  type CloudResourceUsageSnapshot,
  type CloudResourcesSnapshot,
  activeCloudApiTokens,
  createCloudApiKey,
  deleteCloudflareResource,
  friendlyResourceFamilyName,
  getCloudApiKeysSnapshot,
  getCloudResourceUsageSnapshot,
  getProviderCompatCloudflareWorkersInventory,
  getCloudResourcesSnapshot,
  mergeCloudResourceUsageRows,
  revokeCloudApiKey,
} from "../../lib/cloud-resources.ts";
import {
  formatDateTime,
  intlLocale,
  locale,
  type MessageKey,
  t,
} from "../../i18n/index.ts";
import {
  formatBillingNumber,
  formatUsdMicros,
} from "../../lib/billing-format.ts";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardSection,
  type Column,
  DataTable,
  EmptyState,
  FormField,
  Input,
  KVList,
  PageHeader,
  Skeleton,
  Toast,
} from "../../components/ui/index.ts";
import type { TakosumiAccountsPatMetadata } from "@takosjp/takosumi-accounts-contract";

const RESOURCE_PREVIEW_LIMIT = 5;

const RESOURCE_FAMILY_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  "cloudflare.kv": "cloudResources.inventory.kv",
  "cloudflare.r2": "cloudResources.inventory.r2",
  "cloudflare.d1": "cloudResources.inventory.d1",
  "cloudflare.queues": "cloudResources.inventory.queues",
  "cloudflare.queue": "cloudResources.inventory.queues",
  "cloudflare.workflows": "cloudResources.inventory.workflows",
  "cloudflare.workflow": "cloudResources.inventory.workflows",
  "cloudflare.workers": "cloudResources.inventory.workers",
  "cloudflare.worker_script": "cloudResources.inventory.workers",
  "cloudflare.workers_script": "cloudResources.inventory.workers",
  "takosumi.edge_worker": "cloudResources.inventory.workers",
  "takosumi.object_store": "cloudResources.inventory.r2",
  "takosumi.queue": "cloudResources.inventory.queues",
  "takosumi.database": "cloudResources.inventory.d1",
};

interface CloudRefreshState {
  readonly refresh: () => void;
  readonly disabled: boolean;
}

const IDLE_REFRESH_STATE: CloudRefreshState = {
  refresh: () => undefined,
  disabled: true,
};

export default function CloudResourcesView() {
  createEffect(() => {
    if (typeof document !== "undefined") {
      document.title = `${t("cloudResources.title")} — ${dashboardProductName()}`;
    }
  });
  const [refreshState, setRefreshState] =
    createSignal<CloudRefreshState>(IDLE_REFRESH_STATE);

  return (
    <>
      <CloudResourcesHeader
        refresh={() => refreshState().refresh()}
        disabled={refreshState().disabled}
      />
      <AuthGuard loadingFallback={<CloudResourcesLoading />}>
        {() => (
          <CloudResourcesPanel
            showHeader={false}
            onRefreshState={setRefreshState}
          />
        )}
      </AuthGuard>
    </>
  );
}

export function CloudResourcesPanel(props: {
  readonly showHeader?: boolean;
  readonly onRefreshState?: (state: CloudRefreshState) => void;
}) {
  const cloudContext = createMemo<CloudRequestContext>(() => {
    const workspaceId = currentWorkspaceId();
    return workspaceId ? { workspaceId } : {};
  });
  const [snapshot, { refetch: refetchSnapshot }] = createResource(
    () => (isTakosumiCloudRuntime() ? cloudContext() : undefined),
    getCloudResourcesSnapshot,
  );
  const [inventory, { refetch: refetchInventory }] = createResource(
    () => {
      const compatRoute = snapshot()?.compatRoute;
      return compatRoute
        ? { route: compatRoute, context: cloudContext() }
        : undefined;
    },
    ({ route, context }) =>
      getProviderCompatCloudflareWorkersInventory(route, context),
  );
  const [usage, { refetch: refetchUsage }] = createResource(
    () => {
      const context = cloudContext();
      return isTakosumiCloudRuntime() && context.workspaceId
        ? context
        : undefined;
    },
    (context) => getCloudResourceUsageSnapshot(context),
  );
  const [copied, setCopied] = createSignal<string | null>(null);
  const [copyFailed, setCopyFailed] = createSignal(false);
  const refreshAll = () => {
    void refetchSnapshot();
    void refetchInventory();
    void refetchUsage();
  };
  const refreshDisabled = () =>
    !isTakosumiCloudRuntime() || snapshot.loading || usage.loading;

  createEffect(() => {
    props.onRefreshState?.({
      refresh: refreshAll,
      disabled: refreshDisabled(),
    });
  });
  onCleanup(() => props.onRefreshState?.(IDLE_REFRESH_STATE));

  const copyText = async (key: string, value: string) => {
    // Clipboard write can be rejected (permissions / insecure context). This
    // is the copy path for once-only values, so a silent unhandledrejection
    // is not acceptable — surface a visible, announced error instead.
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      setCopied(null);
      setCopyFailed(true);
      return;
    }
    setCopyFailed(false);
    setCopied(key);
    window.setTimeout(() => {
      setCopied((current) => (current === key ? null : current));
    }, 1600);
  };

  return (
    <>
      <Show when={props.showHeader}>
        <CloudResourcesHeader
          refresh={refreshAll}
          disabled={refreshDisabled()}
        />
      </Show>

      <Show
        when={isTakosumiCloudRuntime()}
        fallback={
          <EmptyState
            icon={<Cloud size={24} />}
            title={t("cloudResources.unavailable.title")}
            message={t("cloudResources.unavailable.body")}
          />
        }
      >
        <Switch>
          <Match when={snapshot.loading}>
            <CloudResourcesLoading />
          </Match>
          <Match when={snapshot.error}>
            <Toast tone="error">
              {t("cloudResources.error", {
                message: errorMessage(snapshot.error),
              })}
            </Toast>
          </Match>
          <Match when={snapshot()}>
            {(loaded) => (
              <CloudResourceBody
                snapshot={loaded()}
                inventory={inventory()}
                inventoryLoading={inventory.loading}
                inventoryError={inventory.error}
                usage={usage()}
                usageLoading={usage.loading}
                usageError={usage.error}
                context={cloudContext()}
                copied={copied()}
                copyFailed={copyFailed()}
                copyText={copyText}
                refetchInventory={() => void refetchInventory()}
              />
            )}
          </Match>
        </Switch>
      </Show>
    </>
  );
}

export function CloudApiKeysPanel(props: { readonly showHeader?: boolean }) {
  const [keys, { refetch }] = createResource(
    () => (isTakosumiCloudRuntime() ? "cloud-api-keys" : undefined),
    getCloudApiKeysSnapshot,
  );
  const [copied, setCopied] = createSignal<string | null>(null);
  const [copyFailed, setCopyFailed] = createSignal(false);
  const tokens = createMemo(() => {
    const result = keys();
    return result?.ok ? activeCloudApiTokens(result.data) : [];
  });
  const copyText = async (key: string, value: string) => {
    // The created API-key token is shown exactly once; a rejected clipboard
    // write must surface an announced error, not an unhandledrejection.
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      setCopied(null);
      setCopyFailed(true);
      return;
    }
    setCopyFailed(false);
    setCopied(key);
    window.setTimeout(() => {
      setCopied((current) => (current === key ? null : current));
    }, 1600);
  };

  return (
    <>
      <Show when={props.showHeader}>
        <CloudApiKeysHeader />
      </Show>

      <Show
        when={isTakosumiCloudRuntime()}
        fallback={
          <EmptyState
            icon={<KeyRound size={24} />}
            title={t("cloudResources.unavailable.title")}
            message={t("cloudResources.unavailable.body")}
          />
        }
      >
        <Switch>
          <Match when={keys.loading}>
            <CloudResourcesLoading />
          </Match>
          <Match when={keys()}>
            {(loaded) => (
              <div class="av-cloud-stack">
                <Show when={copied()}>
                  <Toast tone="success">{t("cloudResources.copied")}</Toast>
                </Show>
                <Show when={copyFailed()}>
                  <Toast tone="error">{t("cloudResources.copyFailed")}</Toast>
                </Show>
                <ApiKeysCard
                  tokens={tokens()}
                  copied={copied()}
                  copyText={copyText}
                  refetch={() => void refetch()}
                  result={loaded()}
                />
              </div>
            )}
          </Match>
        </Switch>
      </Show>
    </>
  );
}

function CloudResourcesHeader(props: {
  readonly refresh: () => void;
  readonly disabled: boolean;
}): JSX.Element {
  return (
    <PageHeader
      title={t("cloudResources.title")}
      subtitle={t("cloudResources.subtitle")}
      actions={
        <>
          <Button
            variant="secondary"
            icon={<KeyRound size={16} />}
            href="/advanced/workspace/keys"
          >
            {t("workspaceSettings.tab.keys")}
          </Button>
          <Button
            variant="secondary"
            icon={<RefreshCw size={16} />}
            onClick={props.refresh}
            disabled={props.disabled}
          >
            {t("common.refresh")}
          </Button>
        </>
      }
    />
  );
}

function CloudApiKeysHeader(): JSX.Element {
  return (
    <PageHeader
      title={t("cloudResources.keys.title")}
      subtitle={t("cloudResources.keys.subtitle")}
    />
  );
}

function CloudResourcesLoading(): JSX.Element {
  return (
    <div class="av-cloud-stack" role="status" aria-label={t("common.loading")}>
      <div class="av-cloud-grid">
        <Skeleton variant="card" count={3} />
      </div>
    </div>
  );
}

function CloudResourceBody(props: {
  readonly snapshot: CloudResourcesSnapshot;
  readonly inventory: ProviderCompatCloudflareWorkersInventory | undefined;
  readonly inventoryLoading: boolean;
  readonly inventoryError: unknown;
  readonly usage: CloudResourceUsageSnapshot | undefined;
  readonly usageLoading: boolean;
  readonly usageError: unknown;
  readonly context: CloudRequestContext;
  readonly copied: string | null;
  readonly copyFailed: boolean;
  readonly copyText: (key: string, value: string) => Promise<void>;
  readonly refetchInventory: () => void;
}) {
  const rows = createMemo(() =>
    mergeCloudResourceUsageRows(props.usage, props.inventory),
  );
  const periodLabel = createMemo(() =>
    props.usage
      ? formatUsageMonth(props.usage.period.startIso)
      : t("cloudResources.usage.currentMonth"),
  );
  const totalUsdMicros = createMemo(
    () => props.usage?.totalUsdMicros ?? sumUsdMicros(rows()),
  );
  const usageEventCount = createMemo(() => props.usage?.eventCount ?? 0);
  const compatReady = createMemo(
    () =>
      props.snapshot.compatRoute?.configured === true &&
      props.snapshot.compatToken.ok &&
      props.snapshot.compatToken.data.success === true,
  );
  const tokenStatus = createMemo(() =>
    props.snapshot.compatToken.ok
      ? (props.snapshot.compatToken.data.result?.status ?? "active")
      : undefined,
  );
  const compatCapabilities = createMemo(() =>
    props.snapshot.compatRoute?.capabilities?.length
      ? props.snapshot.compatRoute.capabilities
      : ["compat.cloudflare.workers.v1"],
  );
  const selectedAccount = createMemo(
    () => props.inventory?.selectedAccountId ?? "—",
  );

  return (
    <div class="av-cloud-stack">
      <Show when={props.copied}>
        <Toast tone="success">{t("cloudResources.copied")}</Toast>
      </Show>
      <Show when={props.copyFailed}>
        <Toast tone="error">{t("cloudResources.copyFailed")}</Toast>
      </Show>

      <div class="av-cloud-grid">
        <Card class="av-cloud-card">
          <CardHeader
            title={
              <IconTitle
                icon={<Activity size={18} />}
                label={t("cloudResources.usage.title")}
              />
            }
            subtitle={t("cloudResources.usage.subtitle", {
              period: periodLabel(),
            })}
            actions={
              props.usageLoading ? (
                <Badge tone="neutral">{t("common.loading")}</Badge>
              ) : undefined
            }
          />
          <KVList
            items={[
              {
                label: t("cloudResources.usage.totalCost"),
                value: formatUsdMicros(totalUsdMicros()),
              },
              {
                label: t("cloudResources.usage.resourceTypes"),
                value: String(rows().length),
              },
              {
                label: t("cloudResources.usage.events"),
                value: formatBillingNumber(usageEventCount()),
              },
            ]}
          />
          <Show when={props.usageError}>
            {(error) => (
              <Toast tone="error">
                {t("cloudResources.usage.error", {
                  message: errorMessage(error()),
                })}
              </Toast>
            )}
          </Show>
        </Card>

        <Card class="av-cloud-card">
          <CardHeader
            title={
              <IconTitle
                icon={<ShieldCheck size={18} />}
                label={t("cloudResources.management.title")}
              />
            }
            subtitle={t("cloudResources.management.subtitle")}
            actions={
              <ReadyBadge
                ready={compatReady() && props.inventory !== undefined}
              />
            }
          />
          <KVList
            items={[
              {
                label: t("cloudResources.management.profile"),
                value: "compat.cloudflare.workers.v1",
              },
              {
                label: t("cloudResources.management.auth"),
                value: tokenStatus() ?? "—",
              },
              {
                label: t("cloudResources.management.account"),
                value: selectedAccount(),
              },
            ]}
          />
          <CardSection>
            <ChipBlock
              title={t("cloudResources.management.capabilities")}
              values={compatCapabilities()}
            />
          </CardSection>
          <ResultNotice result={props.snapshot.compatToken} />
        </Card>
      </div>

      <UsageByResourceCard
        rows={rows()}
        loading={props.usageLoading || props.inventoryLoading}
        usageError={props.usageError}
        inventoryError={props.inventoryError}
      />

      <ResourcesCard
        snapshot={props.snapshot}
        inventory={props.inventory}
        inventoryLoading={props.inventoryLoading}
        inventoryError={props.inventoryError}
        context={props.context}
        copied={props.copied}
        copyText={props.copyText}
        refetch={props.refetchInventory}
      />
    </div>
  );
}

function UsageByResourceCard(props: {
  readonly rows: readonly CloudResourceUsageDisplayRow[];
  readonly loading: boolean;
  readonly usageError: unknown;
  readonly inventoryError: unknown;
}): JSX.Element {
  const columns = createMemo<readonly Column<CloudResourceUsageDisplayRow>[]>(
    () => [
      {
        header: t("cloudResources.usage.resourceType"),
        cell: (row) => (
          <div class="av-cloud-usage-main">
            <span class="av-cloud-token-name">
              {resourceFamilyLabel(row.key)}
            </span>
            <span class="muted">{row.key}</span>
          </div>
        ),
      },
      {
        header: t("cloudResources.usage.resourceCount"),
        align: "right",
        cell: (row) => resourceCountLabel(row),
      },
      {
        header: t("cloudResources.usage.quantity"),
        cell: (row) => formatUsageQuantities(row.quantities),
      },
      {
        header: t("cloudResources.usage.estimatedCost"),
        align: "right",
        cell: (row) => formatUsdMicros(row.usdMicros),
      },
      {
        header: t("cloudResources.usage.lastUsed"),
        cell: (row) =>
          row.lastUsedAt
            ? formatDateTime(row.lastUsedAt)
            : t("cloudResources.usage.noUsage"),
      },
      {
        header: t("cloudResources.usage.management"),
        align: "right",
        cell: (row) =>
          row.inventoryKind ? (
            <Badge tone="info">
              {t("cloudResources.usage.manageAvailable")}
            </Badge>
          ) : (
            <Badge tone="neutral">{t("cloudResources.usage.usageOnly")}</Badge>
          ),
      },
    ],
  );

  const blockingError = createMemo(() =>
    props.usageError && props.rows.length === 0 ? props.usageError : undefined,
  );

  return (
    <Card class="av-cloud-card">
      <CardHeader
        title={
          <IconTitle
            icon={<Cloud size={18} />}
            label={t("cloudResources.usage.tableTitle")}
          />
        }
        subtitle={t("cloudResources.usage.tableSubtitle")}
      />
      <DataTable
        columns={columns()}
        rows={props.rows}
        rowKey={(row) => row.key}
        loading={props.loading && props.rows.length === 0}
        error={
          blockingError() ? (
            <Toast tone="error">
              {t("cloudResources.usage.error", {
                message: errorMessage(blockingError()),
              })}
            </Toast>
          ) : undefined
        }
        empty={<span class="muted">{t("cloudResources.usage.empty")}</span>}
        skeletonRows={4}
      />
      <Show when={props.usageError && props.rows.length > 0}>
        <CardSection>
          <Toast tone="error">
            {t("cloudResources.usage.error", {
              message: errorMessage(props.usageError),
            })}
          </Toast>
        </CardSection>
      </Show>
      <Show when={props.inventoryError && props.rows.length > 0}>
        <CardSection>
          <Toast tone="error">
            {t("cloudResources.inventory.error", {
              message: errorMessage(props.inventoryError),
            })}
          </Toast>
        </CardSection>
      </Show>
    </Card>
  );
}

function ApiKeysCard(props: {
  readonly tokens: readonly TakosumiAccountsPatMetadata[];
  readonly copied: string | null;
  readonly copyText: (key: string, value: string) => Promise<void>;
  readonly refetch: () => void;
  readonly result: CloudResourceResult<readonly TakosumiAccountsPatMetadata[]>;
}): JSX.Element {
  const { confirm } = useConfirmDialog();
  const [name, setName] = createSignal(t("cloudResources.keys.defaultName"));
  const [busy, setBusy] = createSignal(false);
  const [revokeBusy, setRevokeBusy] = createSignal<string | null>(null);
  const [createdToken, setCreatedToken] = createSignal<string | null>(null);
  // Which key the once-only token above belongs to: revoking a DIFFERENT key
  // must not destroy the just-created key's single display of its secret.
  const [createdTokenId, setCreatedTokenId] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const createKey = async () => {
    const keyName = name().trim();
    if (!keyName) {
      setError(t("cloudResources.keys.nameRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await createCloudApiKey({ name: keyName });
      setCreatedToken(response.token);
      setCreatedTokenId(response.token_record.id);
      props.refetch();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const revokeKey = async (token: TakosumiAccountsPatMetadata) => {
    const ok = await confirm({
      title: t("cloudResources.keys.revokeTitle"),
      message: t("cloudResources.keys.revokeMessage", { name: token.name }),
      confirmText: t("cloudResources.keys.revoke"),
      danger: true,
    });
    if (!ok) return;
    const tokenId = token.id;
    setRevokeBusy(tokenId);
    setError(null);
    try {
      await revokeCloudApiKey(tokenId);
      if (createdTokenId() === tokenId) {
        setCreatedToken(null);
        setCreatedTokenId(null);
      }
      props.refetch();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRevokeBusy(null);
    }
  };

  return (
    <Card class="av-cloud-card">
      <CardHeader
        title={
          <IconTitle
            icon={<KeyRound size={18} />}
            label={t("cloudResources.keys.title")}
          />
        }
        subtitle={t("cloudResources.keys.subtitle")}
        actions={<Badge tone="info">{t("cloudResources.keys.scope")}</Badge>}
      />
      <div class="av-cloud-key-create">
        <FormField label={t("cloudResources.keys.name")}>
          <Input
            id="cloud-api-key-name"
            name="cloud_api_key_name"
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </FormField>
        <Button
          variant="primary"
          type="button"
          busy={busy()}
          onClick={() => void createKey()}
        >
          {t("cloudResources.keys.create")}
        </Button>
      </div>
      <Show when={createdToken()}>
        {(token) => (
          <CardSection>
            <p class="muted">{t("cloudResources.keys.createdNotice")}</p>
            <CopyValueRow
              label={t("cloudResources.keys.created")}
              value={token()}
              copyKey="created-token"
              copied={props.copied}
              copyText={props.copyText}
            />
          </CardSection>
        )}
      </Show>
      <Show when={error()}>
        {(message) => <Toast tone="error">{message()}</Toast>}
      </Show>
      <ResultNotice result={props.result} />
      <Show when={props.tokens.length > 0}>
        <CardSection>
          <p class="muted">{t("cloudResources.keys.secretNotice")}</p>
          <div class="av-cloud-token-list">
            <For each={props.tokens}>
              {(token) => (
                <div class="av-cloud-token-row">
                  <div class="av-cloud-token-main">
                    <span class="av-cloud-token-name">{token.name}</span>
                    <span class="muted">
                      {token.prefix}... · {token.scopes.join(", ")}
                    </span>
                    <span class="muted">
                      {t("cloudResources.keys.lastUsed")}:{" "}
                      {formatDateTime(token.last_used_at)}
                    </span>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    type="button"
                    icon={<Trash2 size={14} />}
                    busy={revokeBusy() === token.id}
                    onClick={() => void revokeKey(token)}
                  >
                    {t("cloudResources.keys.revoke")}
                  </Button>
                </div>
              )}
            </For>
          </div>
        </CardSection>
      </Show>
      <Show when={props.result.ok && props.tokens.length === 0}>
        <CardSection>
          <p class="muted">{t("cloudResources.keys.empty")}</p>
        </CardSection>
      </Show>
    </Card>
  );
}

interface ResourceItem {
  readonly id: string;
  readonly name: string;
}

interface ResourceGroup {
  readonly kind: CloudflareResourceKind;
  readonly label: string;
  readonly icon: JSX.Element;
  readonly result: CloudResourceResult<readonly ResourceItem[]>;
}

function ResourcesCard(props: {
  readonly snapshot: CloudResourcesSnapshot;
  readonly inventory: ProviderCompatCloudflareWorkersInventory | undefined;
  readonly inventoryLoading: boolean;
  readonly inventoryError: unknown;
  readonly context: CloudRequestContext;
  readonly copied: string | null;
  readonly copyText: (key: string, value: string) => Promise<void>;
  readonly refetch: () => void;
}): JSX.Element {
  const { confirm } = useConfirmDialog();
  const [expandedGroups, setExpandedGroups] = createSignal<
    Readonly<Record<CloudflareResourceKind, boolean>>
  >({
    kv: false,
    r2: false,
    d1: false,
    queue: false,
    workflow: false,
    worker: false,
  });
  const inventory = () =>
    props.inventory ??
    emptyProviderCompatCloudflareWorkersInventory(
      props.inventoryError
        ? errorMessage(props.inventoryError)
        : t("common.loading"),
    );
  const accountId = () => inventory().selectedAccountId;
  const compatBasePath = () => props.snapshot.compatRoute?.basePath;
  const canManage = () => Boolean(accountId() && compatBasePath());

  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [deleted, setDeleted] = createSignal<string | null>(null);

  const groups = createMemo<readonly ResourceGroup[]>(() => {
    const inv = inventory();
    return [
      {
        kind: "kv",
        label: t("cloudResources.inventory.kv"),
        icon: <Database size={16} />,
        result: mapResult(inv.kvNamespaces, (item) => ({
          id: item.id ?? "",
          name: item.title ?? item.id ?? "",
        })),
      },
      {
        kind: "r2",
        label: t("cloudResources.inventory.r2"),
        icon: <HardDrive size={16} />,
        result: mapResult(inv.r2Buckets, (item) => ({
          id: item.name ?? "",
          name: item.name ?? "",
        })),
      },
      {
        kind: "d1",
        label: t("cloudResources.inventory.d1"),
        icon: <Database size={16} />,
        result: mapResult(inv.d1Databases, (item) => ({
          id: item.uuid ?? item.id ?? "",
          name: item.name ?? item.uuid ?? item.id ?? "",
        })),
      },
      {
        kind: "queue",
        label: t("cloudResources.inventory.queues"),
        icon: <Activity size={16} />,
        result: mapResult(inv.queues, (item) => ({
          id: item.queue_id ?? item.id ?? item.queue_name ?? "",
          name: item.queue_name ?? item.queue_id ?? item.id ?? "",
        })),
      },
      {
        kind: "workflow",
        label: t("cloudResources.inventory.workflows"),
        icon: <Activity size={16} />,
        result: mapResult(inv.workflows, (item) => ({
          id: item.workflow_name ?? item.name ?? item.id ?? "",
          name: item.workflow_name ?? item.name ?? item.id ?? "",
        })),
      },
      {
        kind: "worker",
        label: t("cloudResources.inventory.workers"),
        icon: <Cloud size={16} />,
        result: mapResult(inv.workerScripts, (item) => {
          const scriptName = workerScriptName(item);
          return { id: scriptName, name: scriptName };
        }),
      },
    ];
  });

  const removeResource = async (group: ResourceGroup, item: ResourceItem) => {
    const account = accountId();
    const base = compatBasePath();
    if (!account || !base || !item.id) return;
    const ok = await confirm({
      title: t("cloudResources.resources.deleteTitle"),
      message: t("cloudResources.resources.deleteMessage", {
        name: item.name || item.id,
      }),
      confirmText: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    const busyKey = `${group.kind}:${item.id}`;
    setBusy(busyKey);
    setError(null);
    setDeleted(null);
    try {
      await deleteCloudflareResource({
        compatBasePath: base,
        accountId: account,
        kind: group.kind,
        id: item.id,
        context: props.context,
      });
      setDeleted(item.name || item.id);
      props.refetch();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card class="av-cloud-card">
      <CardHeader
        title={
          <IconTitle
            icon={<Activity size={18} />}
            label={t("cloudResources.inventory.title")}
          />
        }
        subtitle={t("cloudResources.inventory.subtitle")}
        actions={
          props.inventoryLoading ? (
            <Badge tone="neutral">{t("common.loading")}</Badge>
          ) : undefined
        }
      />
      <Show when={!props.inventoryLoading && props.inventory && !canManage()}>
        <CardSection>
          <p class="muted">{t("cloudResources.resources.noAccount")}</p>
        </CardSection>
      </Show>
      <Show when={error()}>
        {(message) => <Toast tone="error">{message()}</Toast>}
      </Show>
      <Show when={deleted()}>
        {(name) => (
          <Toast tone="success">
            {t("cloudResources.resources.deleted", { name: name() })}
          </Toast>
        )}
      </Show>
      <Show
        when={props.inventory || !props.inventoryLoading}
        fallback={
          <CardSection>
            <Skeleton variant="row" count={4} />
          </CardSection>
        }
      >
        <div class="av-cloud-res-groups">
          <For each={groups()}>
            {(group) => {
              const allItems = createMemo(() =>
                group.result.ok ? group.result.data : [],
              );
              const expanded = createMemo(() => expandedGroups()[group.kind]);
              const visibleItems = createMemo(() =>
                expanded()
                  ? allItems()
                  : allItems().slice(0, RESOURCE_PREVIEW_LIMIT),
              );
              const hiddenCount = createMemo(() =>
                Math.max(0, allItems().length - visibleItems().length),
              );
              const toggle = () =>
                setExpandedGroups((current) => ({
                  ...current,
                  [group.kind]: !current[group.kind],
                }));

              return (
                <section class="av-cloud-res-group">
                  <div class="av-cloud-res-group-head">
                    <div class="av-cloud-res-group-title">
                      <span class="av-cloud-title-icon" aria-hidden="true">
                        {group.icon}
                      </span>
                      <span>{group.label}</span>
                      <Badge tone={group.result.ok ? "neutral" : "warn"}>
                        {group.result.ok ? group.result.data.length : "!"}
                      </Badge>
                    </div>
                    <Show
                      when={
                        group.result.ok &&
                        group.result.data.length > RESOURCE_PREVIEW_LIMIT
                      }
                    >
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        onClick={toggle}
                      >
                        {expanded()
                          ? t("cloudResources.inventory.showLess")
                          : t("cloudResources.inventory.showAll", {
                              count: String(
                                group.result.ok ? group.result.data.length : 0,
                              ),
                            })}
                      </Button>
                    </Show>
                  </div>
                  <Switch>
                    <Match when={!group.result.ok}>
                      <span class="muted">
                        {group.result.ok ? "" : group.result.error}
                      </span>
                    </Match>
                    <Match
                      when={group.result.ok && group.result.data.length === 0}
                    >
                      <span class="muted">{t("common.none")}</span>
                    </Match>
                    <Match when={group.result.ok}>
                      <div class="av-cloud-token-list">
                        <For each={visibleItems()}>
                          {(item) => (
                            <div class="av-cloud-token-row">
                              <div class="av-cloud-token-main">
                                <span class="av-cloud-token-name">
                                  {item.name || item.id}
                                </span>
                              </div>
                              <div class="av-actions">
                                <Show when={item.id}>
                                  <Button
                                    variant={
                                      props.copied ===
                                      `res:${group.kind}:${item.id}`
                                        ? "primary"
                                        : "secondary"
                                    }
                                    size="sm"
                                    type="button"
                                    icon={
                                      props.copied ===
                                      `res:${group.kind}:${item.id}` ? (
                                        <CheckCircle2 size={14} />
                                      ) : (
                                        <Copy size={14} />
                                      )
                                    }
                                    onClick={() =>
                                      void props.copyText(
                                        `res:${group.kind}:${item.id}`,
                                        item.id,
                                      )
                                    }
                                  >
                                    {t("cloudResources.resources.copyId")}
                                  </Button>
                                </Show>
                                <Button
                                  variant="danger"
                                  size="sm"
                                  type="button"
                                  icon={<Trash2 size={14} />}
                                  busy={busy() === `${group.kind}:${item.id}`}
                                  disabled={!canManage() || !item.id}
                                  onClick={() =>
                                    void removeResource(group, item)
                                  }
                                >
                                  {t("common.delete")}
                                </Button>
                              </div>
                            </div>
                          )}
                        </For>
                        <Show when={hiddenCount() > 0}>
                          <button
                            class="av-cloud-res-more"
                            type="button"
                            onClick={toggle}
                          >
                            {t("cloudResources.inventory.remaining", {
                              count: String(hiddenCount()),
                            })}
                          </button>
                        </Show>
                      </div>
                    </Match>
                  </Switch>
                </section>
              );
            }}
          </For>
        </div>
      </Show>
    </Card>
  );
}

function mapResult<T, U>(
  result: CloudResourceResult<readonly T[]>,
  fn: (item: T) => U,
): CloudResourceResult<readonly U[]> {
  return result.ok ? { ok: true, data: result.data.map(fn) } : result;
}

function resourceFamilyLabel(key: string): string {
  const labelKey = RESOURCE_FAMILY_LABEL_KEYS[key];
  return labelKey ? t(labelKey) : friendlyResourceFamilyName(key);
}

function resourceCountLabel(row: CloudResourceUsageDisplayRow): JSX.Element {
  if (row.resourceCount !== undefined) return String(row.resourceCount);
  if (row.inventoryError) {
    return (
      <Badge tone="warn">{t("cloudResources.usage.checkInventory")}</Badge>
    );
  }
  return "—";
}

function formatUsageQuantities(
  quantities: readonly CloudResourceUsageQuantity[],
): string {
  if (quantities.length === 0) return t("cloudResources.usage.noUsage");
  return quantities
    .map(
      (quantity) =>
        `${formatBillingNumber(quantity.quantity)} ${usageKindUnitLabel(
          quantity.kind,
        )}`,
    )
    .join(", ");
}

function usageKindUnitLabel(kind: string): string {
  switch (kind) {
    case "runner_minute":
      return t("cloudResources.usage.unit.runnerMinute");
    case "artifact_storage_gb_hour":
    case "backup_storage_gb_hour":
    case "gateway_storage_gb_hour":
      return t("cloudResources.usage.unit.gbHour");
    case "egress_gb":
      return t("cloudResources.usage.unit.gb");
    case "gateway_compute":
      return t("cloudResources.usage.unit.compute");
    case "ai_request":
      return t("cloudResources.usage.unit.aiRequest");
    case "ai_input_token":
      return t("cloudResources.usage.unit.inputToken");
    case "ai_output_token":
      return t("cloudResources.usage.unit.outputToken");
    case "operation":
      return t("cloudResources.usage.unit.operation");
    default:
      return friendlyResourceFamilyName(kind).toLowerCase();
  }
}

function formatUsageMonth(startIso: string): string {
  const date = new Date(startIso);
  return new Intl.DateTimeFormat(intlLocale(), {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(date);
}

function sumUsdMicros(rows: readonly CloudResourceUsageDisplayRow[]): number {
  return rows.reduce((total, row) => total + row.usdMicros, 0);
}

function emptyProviderCompatCloudflareWorkersInventory(
  error: string,
): ProviderCompatCloudflareWorkersInventory {
  return {
    accounts: { ok: false, error },
    kvNamespaces: { ok: false, error },
    d1Databases: { ok: false, error },
    r2Buckets: { ok: false, error },
    queues: { ok: false, error },
    workflows: { ok: false, error },
    workerScripts: { ok: false, error },
  };
}

function IconTitle(props: {
  readonly icon: JSX.Element;
  readonly label: string;
}): JSX.Element {
  return (
    <span class="av-cloud-title">
      <span class="av-cloud-title-icon" aria-hidden="true">
        {props.icon}
      </span>
      {props.label}
    </span>
  );
}

function ReadyBadge(props: { readonly ready: boolean }): JSX.Element {
  return (
    <Badge tone={props.ready ? "ok" : "warn"}>
      {props.ready
        ? t("cloudResources.status.ready")
        : t("cloudResources.status.check")}
    </Badge>
  );
}

function CopyValueRow(props: {
  readonly label: string;
  readonly value: string;
  readonly copyKey: string;
  readonly copied: string | null;
  readonly copyText: (key: string, value: string) => Promise<void>;
}): JSX.Element {
  return (
    <div class="av-cloud-copy-row">
      <span class="av-cloud-copy-label">{props.label}</span>
      <code class="wc-code av-cloud-copy-value">{props.value}</code>
      <Button
        variant={props.copied === props.copyKey ? "primary" : "secondary"}
        size="sm"
        icon={
          props.copied === props.copyKey ? (
            <CheckCircle2 size={14} />
          ) : (
            <Copy size={14} />
          )
        }
        onClick={() => void props.copyText(props.copyKey, props.value)}
      >
        {t("common.copy")}
      </Button>
    </div>
  );
}

function ChipBlock(props: {
  readonly title: string;
  readonly values: readonly string[];
}): JSX.Element {
  return (
    <div class="av-cloud-chip-block">
      <p class="av-cloud-chip-title">{props.title}</p>
      <Show
        when={props.values.length > 0}
        fallback={<span class="muted">{t("common.none")}</span>}
      >
        <div class="av-cloud-chip-list">
          <For each={props.values}>
            {(value) => <span class="av-cloud-chip">{value}</span>}
          </For>
        </div>
      </Show>
    </div>
  );
}

function ResultNotice<T>(props: {
  readonly result: CloudResourceResult<T>;
}): JSX.Element {
  return (
    <Show when={!props.result.ok}>
      <CardSection>
        <Toast tone="error">
          {t("cloudResources.partialError", {
            message: props.result.ok ? "" : props.result.error,
          })}
        </Toast>
      </CardSection>
    </Show>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function workerScriptName(script: Readonly<Record<string, unknown>>): string {
  for (const key of ["script_name", "id", "name"]) {
    const value = script[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}
