/**
 * Cloud screen (`/cloud`) — Takosumi Cloud only. Two management surfaces:
 *   - Cloud API keys (create / list / revoke)
 *   - Cloud resources (KV / Object Storage / Database / Queue / Workers Script):
 *     list, copy identifiers, and DELETE through the Cloudflare compatibility
 *     gateway.
 * Plus compact endpoint reference cards (AI gateway, Cloudflare compat).
 *
 * Usage / billing intentionally lives on the Billing (支払い) tab, not here, so
 * this screen stays focused on keys + resources.
 */
import "../../styles/wave-c.css";
import {
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import type { JSX } from "solid-js";
import {
  Activity,
  BrainCircuit,
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
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import { isTakosumiCloudRuntime } from "../../lib/deployment-brand.ts";
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";
import {
  type CloudflareResourceKind,
  type CloudResourceResult,
  type CloudResourcesSnapshot,
  createCloudApiKey,
  deleteCloudflareResource,
  getCloudResourcesSnapshot,
  revokeCloudApiKey,
} from "../../lib/cloud-resources.ts";
import { formatDateTime, t } from "../../i18n/index.ts";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardSection,
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

export default function CloudResourcesView() {
  return <Page title={t("cloudResources.title")}>{() => <Inner />}</Page>;
}

function Inner() {
  const [snapshot, { refetch }] = createResource(
    () => (isTakosumiCloudRuntime() ? true : undefined),
    getCloudResourcesSnapshot,
  );
  const [copied, setCopied] = createSignal<string | null>(null);

  const copyText = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => {
      setCopied((current) => (current === key ? null : current));
    }, 1600);
  };

  return (
    <AppShell>
      <PageHeader
        title={t("cloudResources.title")}
        subtitle={t("cloudResources.subtitle")}
        actions={
          <Button
            variant="secondary"
            icon={<RefreshCw size={16} />}
            onClick={() => void refetch()}
            disabled={!isTakosumiCloudRuntime() || snapshot.loading}
          >
            {t("common.retry")}
          </Button>
        }
      />

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
            <div class="av-cloud-grid">
              <Skeleton variant="card" count={3} />
            </div>
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
                copied={copied()}
                copyText={copyText}
                refetch={() => void refetch()}
              />
            )}
          </Match>
        </Switch>
      </Show>
    </AppShell>
  );
}

function CloudResourceBody(props: {
  readonly snapshot: CloudResourcesSnapshot;
  readonly copied: string | null;
  readonly copyText: (key: string, value: string) => Promise<void>;
  readonly refetch: () => void;
}) {
  const aiBaseUrl = createMemo(() =>
    endpointUrl(props.snapshot.catalog.serviceUrl, props.snapshot.aiRoute),
  );
  const compatBaseUrl = createMemo(() =>
    endpointUrl(props.snapshot.catalog.serviceUrl, props.snapshot.compatRoute),
  );
  const aiReady = createMemo(
    () =>
      props.snapshot.aiRoute?.configured === true &&
      props.snapshot.aiStatus.ok &&
      props.snapshot.aiModels.ok,
  );
  const compatReady = createMemo(
    () =>
      props.snapshot.compatRoute?.configured === true &&
      props.snapshot.compatToken.ok &&
      props.snapshot.compatToken.data.success === true,
  );
  const providers = createMemo(() =>
    props.snapshot.aiStatus.ok
      ? props.snapshot.aiStatus.data.summary.providers
      : [],
  );
  const models = createMemo(() =>
    props.snapshot.aiModels.ok ? props.snapshot.aiModels.data.data : [],
  );
  const defaultModel = createMemo(() =>
    props.snapshot.aiStatus.ok
      ? props.snapshot.aiStatus.data.defaultModel
      : undefined,
  );
  const tokenStatus = createMemo(() =>
    props.snapshot.compatToken.ok
      ? (props.snapshot.compatToken.data.result?.status ?? "active")
      : undefined,
  );
  const tokens = createMemo(() =>
    props.snapshot.accountTokens.ok ? props.snapshot.accountTokens.data : [],
  );

  return (
    <div class="av-cloud-stack">
      <Show when={props.copied}>
        <Toast tone="success">{t("cloudResources.copied")}</Toast>
      </Show>

      <ApiKeysCard
        tokens={tokens()}
        copied={props.copied}
        copyText={props.copyText}
        refetch={props.refetch}
        result={props.snapshot.accountTokens}
      />

      <ResourcesCard
        snapshot={props.snapshot}
        copied={props.copied}
        copyText={props.copyText}
        refetch={props.refetch}
      />

      <div class="av-cloud-grid">
        <Card class="av-cloud-card">
          <CardHeader
            title={
              <IconTitle
                icon={<BrainCircuit size={18} />}
                label={t("cloudResources.ai.title")}
              />
            }
            subtitle={t("cloudResources.ai.subtitle")}
            actions={<ReadyBadge ready={aiReady()} />}
          />
          <EndpointRow
            label={t("cloudResources.baseUrl")}
            value={aiBaseUrl()}
            copyKey="ai-base-url"
            copied={props.copied}
            copyText={props.copyText}
          />
          <KVList
            items={[
              {
                label: t("cloudResources.ai.defaultModel"),
                value: defaultModel() ?? "—",
              },
              {
                label: t("cloudResources.ai.models"),
                value: String(models().length),
              },
              {
                label: t("cloudResources.ai.providers"),
                value: providers().join(", ") || "—",
              },
            ]}
          />
          <CardSection>
            <ChipBlock
              title={t("cloudResources.ai.modelDetails")}
              values={models().map((model) => model.id)}
            />
          </CardSection>
          <ResultNotice result={props.snapshot.aiStatus} />
        </Card>

        <Card class="av-cloud-card">
          <CardHeader
            title={
              <IconTitle
                icon={<ShieldCheck size={18} />}
                label={t("cloudResources.compat.title")}
              />
            }
            subtitle={t("cloudResources.compat.subtitle")}
            actions={<ReadyBadge ready={compatReady()} />}
          />
          <EndpointRow
            label={t("cloudResources.baseUrl")}
            value={compatBaseUrl()}
            copyKey="compat-base-url"
            copied={props.copied}
            copyText={props.copyText}
          />
          <KVList
            items={[
              {
                label: t("cloudResources.compat.token"),
                value: tokenStatus() ?? "—",
              },
              {
                label: t("cloudResources.compat.account"),
                value: props.snapshot.compatInventory.selectedAccountId ?? "—",
              },
            ]}
          />
          <ResultNotice result={props.snapshot.compatToken} />
        </Card>
      </div>
    </div>
  );
}

function ApiKeysCard(props: {
  readonly tokens: readonly TakosumiAccountsPatMetadata[];
  readonly copied: string | null;
  readonly copyText: (key: string, value: string) => Promise<void>;
  readonly refetch: () => void;
  readonly result: CloudResourceResult<readonly TakosumiAccountsPatMetadata[]>;
}): JSX.Element {
  const [name, setName] = createSignal(t("cloudResources.keys.defaultName"));
  const [busy, setBusy] = createSignal(false);
  const [revokeBusy, setRevokeBusy] = createSignal<string | null>(null);
  const [createdToken, setCreatedToken] = createSignal<string | null>(null);
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
      props.refetch();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const revokeKey = async (tokenId: string) => {
    setRevokeBusy(tokenId);
    setError(null);
    try {
      await revokeCloudApiKey(tokenId);
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
            <EndpointRow
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
                    onClick={() => void revokeKey(token.id)}
                  >
                    {t("common.delete")}
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
    worker: false,
  });
  const inventory = () => props.snapshot.compatInventory;
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
      />
      <Show when={!canManage()}>
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
                              <Show when={item.id && item.id !== item.name}>
                                <span class="muted av-cloud-res-id">
                                  {item.id}
                                </span>
                              </Show>
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
                                  {t("common.copy")}
                                </Button>
                              </Show>
                              <Button
                                variant="danger"
                                size="sm"
                                type="button"
                                icon={<Trash2 size={14} />}
                                busy={busy() === `${group.kind}:${item.id}`}
                                disabled={!canManage() || !item.id}
                                onClick={() => void removeResource(group, item)}
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
    </Card>
  );
}

function mapResult<T, U>(
  result: CloudResourceResult<readonly T[]>,
  fn: (item: T) => U,
): CloudResourceResult<readonly U[]> {
  return result.ok ? { ok: true, data: result.data.map(fn) } : result;
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

function EndpointRow(props: {
  readonly label: string;
  readonly value: string;
  readonly copyKey: string;
  readonly copied: string | null;
  readonly copyText: (key: string, value: string) => Promise<void>;
}): JSX.Element {
  return (
    <div class="av-cloud-endpoint">
      <span class="av-cloud-endpoint-label">{props.label}</span>
      <code class="wc-code av-cloud-endpoint-value">{props.value}</code>
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

function endpointUrl(
  serviceUrl: string | undefined,
  route:
    | {
        readonly basePath: `/${string}`;
      }
    | undefined,
): string {
  if (!route) return "—";
  const base =
    serviceUrl || (typeof location !== "undefined" ? location.origin : "");
  try {
    return new URL(route.basePath, base).toString();
  } catch {
    return route.basePath;
  }
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
