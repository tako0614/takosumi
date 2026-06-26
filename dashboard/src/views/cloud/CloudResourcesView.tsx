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
  BarChart3,
  BrainCircuit,
  CheckCircle2,
  Cloud,
  Copy,
  Database,
  ExternalLink,
  HardDrive,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import { isTakosumiCloudRuntime } from "../../lib/deployment-brand.ts";
import { currentSpaceId } from "../../lib/space-state.ts";
import {
  createCloudApiKey,
  type CloudResourceResult,
  type CloudResourcesSnapshot,
  revokeCloudApiKey,
  getCloudResourcesSnapshot,
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
import type { UsageEvent } from "../../lib/control-api.ts";
import type { TakosumiAccountsPatMetadata } from "@takosjp/takosumi-accounts-contract";

export default function CloudResourcesView() {
  return <Page title={t("cloudResources.title")}>{() => <Inner />}</Page>;
}

function Inner() {
  const [snapshot, { refetch }] = createResource(
    () =>
      isTakosumiCloudRuntime()
        ? { spaceId: currentSpaceId() || undefined }
        : undefined,
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
  const usage = createMemo(() =>
    props.snapshot.usage.usage.ok ? props.snapshot.usage.usage.data : [],
  );
  const monthUsage = createMemo(() => usage().filter(isThisMonthUsage));
  const monthCredits = createMemo(() =>
    sumBy(monthUsage(), (event) => event.credits),
  );
  const gatewayCredits = createMemo(() =>
    sumBy(
      monthUsage().filter((event) => event.kind.startsWith("gateway_")),
      (event) => event.credits,
    ),
  );
  const recentUsage = createMemo(() =>
    [...usage()]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 4),
  );
  const tokens = createMemo(() =>
    props.snapshot.accountTokens.ok ? props.snapshot.accountTokens.data : [],
  );

  return (
    <div class="av-cloud-stack">
      <Show when={props.copied}>
        <Toast tone="success">{t("cloudResources.copied")}</Toast>
      </Show>

      <div class="av-cloud-grid">
        <ApiKeysCard
          tokens={tokens()}
          copied={props.copied}
          copyText={props.copyText}
          refetch={props.refetch}
          result={props.snapshot.accountTokens}
        />

        <Card class="av-cloud-card">
          <CardHeader
            title={
              <IconTitle
                icon={<BarChart3 size={18} />}
                label={t("cloudResources.usage.title")}
              />
            }
            subtitle={
              props.snapshot.usage.spaceId
                ? t("cloudResources.usage.subtitle")
                : t("cloudResources.usage.noWorkspace")
            }
          />
          <KVList
            items={[
              {
                label: t("cloudResources.usage.monthCredits"),
                value: formatNumber(monthCredits()),
              },
              {
                label: t("cloudResources.usage.gatewayCredits"),
                value: formatNumber(gatewayCredits()),
              },
              {
                label: t("cloudResources.usage.balance"),
                value: props.snapshot.usage.billing.ok
                  ? formatNumber(
                      props.snapshot.usage.billing.data.balance
                        ?.availableCredits ?? 0,
                    )
                  : "—",
              },
            ]}
          />
          <Show when={recentUsage().length > 0}>
            <CardSection>
              <UsageList rows={recentUsage()} />
            </CardSection>
          </Show>
          <Show when={props.snapshot.usage.spaceId}>
            <ResultNotice result={props.snapshot.usage.usage} />
          </Show>
        </Card>

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
                value: defaultModel() ?? "takosumi/default",
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
              title={t("cloudResources.ai.models")}
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
                label: t("cloudResources.provider"),
                value: props.snapshot.compatRoute?.provider ?? "cloudflare",
              },
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

        <CloudInventoryCard snapshot={props.snapshot} />

        <Card class="av-cloud-card av-cloud-card-compact">
          <CardHeader
            title={
              <IconTitle
                icon={<KeyRound size={18} />}
                label={t("cloudResources.docs.title")}
              />
            }
            subtitle={t("cloudResources.docs.subtitle")}
            actions={
              <Button
                variant="secondary"
                size="sm"
                href="https://takosumi.com/docs/reference/cloud-endpoints"
                icon={<ExternalLink size={14} />}
              >
                {t("cloudResources.docs.open")}
              </Button>
            }
          />
          <KVList
            items={[
              {
                label: t("cloudResources.catalog.configured"),
                value: `${props.snapshot.catalog.summary.configured}/${props.snapshot.catalog.summary.total}`,
              },
              {
                label: t("cloudResources.catalog.generated"),
                value: formatDateTime(props.snapshot.catalog.generatedAt),
              },
            ]}
          />
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
  readonly result: CloudResourceResult<
    readonly TakosumiAccountsPatMetadata[]
  >;
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
    <Card class="av-cloud-card av-cloud-card-compact">
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

function UsageList(props: { readonly rows: readonly UsageEvent[] }): JSX.Element {
  return (
    <div class="av-cloud-usage-list">
      <For each={props.rows}>
        {(row) => (
          <div class="av-cloud-usage-row">
            <span>{usageKindLabel(row.kind)}</span>
            <span class="muted">
              {formatNumber(row.quantity)} / {formatNumber(row.credits)}
            </span>
            <span class="muted">{formatDateTime(row.createdAt)}</span>
          </div>
        )}
      </For>
    </div>
  );
}

function CloudInventoryCard(props: {
  readonly snapshot: CloudResourcesSnapshot;
}): JSX.Element {
  const inventory = props.snapshot.compatInventory;
  const resourceCards = createMemo(() => [
    {
      label: t("cloudResources.inventory.kv"),
      icon: <Database size={16} />,
      result: inventory.kvNamespaces,
      names: inventory.kvNamespaces.ok
        ? inventory.kvNamespaces.data.map((item) => item.title ?? item.id ?? "")
        : [],
    },
    {
      label: t("cloudResources.inventory.r2"),
      icon: <HardDrive size={16} />,
      result: inventory.r2Buckets,
      names: inventory.r2Buckets.ok
        ? inventory.r2Buckets.data.map((item) => item.name ?? "")
        : [],
    },
    {
      label: t("cloudResources.inventory.d1"),
      icon: <Database size={16} />,
      result: inventory.d1Databases,
      names: inventory.d1Databases.ok
        ? inventory.d1Databases.data.map(
            (item) => item.name ?? item.uuid ?? item.id ?? "",
          )
        : [],
    },
    {
      label: t("cloudResources.inventory.workers"),
      icon: <Cloud size={16} />,
      result: inventory.workerScripts,
      names: inventory.workerScripts.ok
        ? inventory.workerScripts.data.map(workerScriptName)
        : [],
    },
  ]);
  return (
    <Card class="av-cloud-card av-cloud-card-compact">
      <CardHeader
        title={
          <IconTitle
            icon={<Activity size={18} />}
            label={t("cloudResources.inventory.title")}
          />
        }
        subtitle={t("cloudResources.inventory.subtitle")}
      />
      <div class="av-cloud-resource-grid">
        <For each={resourceCards()}>
          {(resource) => (
            <div class="av-cloud-resource-card">
              <div class="av-cloud-resource-head">
                <span class="av-cloud-title-icon" aria-hidden="true">
                  {resource.icon}
                </span>
                <span>{resource.label}</span>
                <Badge tone={resource.result.ok ? "neutral" : "warn"}>
                  {resource.result.ok ? resource.result.data.length : "!"}
                </Badge>
              </div>
              <Show
                when={resource.result.ok}
                fallback={
                  <span class="muted">
                    {resource.result.ok ? "" : resource.result.error}
                  </span>
                }
              >
                <ChipBlock
                  title={t("cloudResources.inventory.names")}
                  values={resource.names.filter(Boolean).slice(0, 6)}
                />
              </Show>
            </div>
          )}
        </For>
      </div>
    </Card>
  );
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

function isThisMonthUsage(event: UsageEvent): boolean {
  const created = new Date(event.createdAt);
  if (Number.isNaN(created.getTime())) return false;
  const now = new Date();
  return (
    created.getUTCFullYear() === now.getUTCFullYear() &&
    created.getUTCMonth() === now.getUTCMonth()
  );
}

function sumBy<T>(items: readonly T[], fn: (item: T) => number): number {
  return items.reduce((sum, item) => sum + fn(item), 0);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
  }).format(value);
}

function usageKindLabel(kind: string): string {
  switch (kind) {
    case "runner_minute":
      return t("cloudResources.usage.kind.runnerMinute");
    case "operation":
      return t("cloudResources.usage.kind.operation");
    case "gateway_compute":
      return t("cloudResources.usage.kind.compute");
    case "gateway_storage_gb_hour":
      return t("cloudResources.usage.kind.storage");
    case "artifact_storage_gb_hour":
      return t("cloudResources.usage.kind.artifactStorage");
    case "backup_storage_gb_hour":
      return t("cloudResources.usage.kind.backupStorage");
    case "egress_gb":
      return t("cloudResources.usage.kind.egress");
    default:
      return kind;
  }
}
