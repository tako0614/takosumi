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
  BrainCircuit,
  CheckCircle2,
  Cloud,
  Copy,
  KeyRound,
  RefreshCw,
  ShieldCheck,
} from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import { isTakosumiCloudRuntime } from "../../lib/deployment-brand.ts";
import {
  type CloudExtensionCatalogItem,
  type CloudResourceResult,
  type CloudResourcesSnapshot,
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
  KVList,
  PageHeader,
  Skeleton,
  Toast,
} from "../../components/ui/index.ts";

export default function CloudResourcesView() {
  return <Page title={t("cloudResources.title")}>{() => <Inner />}</Page>;
}

function Inner() {
  const [snapshot, { refetch }] = createResource(
    () => (isTakosumiCloudRuntime() ? "cloud" : undefined),
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

  return (
    <div class="av-cloud-stack">
      <Show when={props.copied}>
        <Toast tone="success">{t("cloudResources.copied")}</Toast>
      </Show>

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
                label: t("cloudResources.protocol"),
                value: props.snapshot.aiRoute?.protocol ?? "—",
              },
              {
                label: t("cloudResources.ai.defaultModel"),
                value: defaultModel() ?? "takosumi/default",
              },
              {
                label: t("cloudResources.ai.profiles"),
                value: props.snapshot.aiStatus.ok
                  ? String(props.snapshot.aiStatus.data.summary.profileCount)
                  : "—",
              },
            ]}
          />
          <CardSection>
            <ChipBlock
              title={t("cloudResources.ai.providers")}
              values={providers()}
            />
          </CardSection>
          <CardSection>
            <ChipBlock
              title={t("cloudResources.ai.models")}
              values={models().map((model) => model.id)}
            />
          </CardSection>
          <ResultNotice result={props.snapshot.aiStatus} />
          <Show when={props.snapshot.aiRoute}>
            {(route) => <Capabilities route={route()} />}
          </Show>
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
                label: t("cloudResources.protocol"),
                value: props.snapshot.compatRoute?.protocol ?? "—",
              },
              {
                label: t("cloudResources.provider"),
                value: props.snapshot.compatRoute?.provider ?? "cloudflare",
              },
              {
                label: t("cloudResources.compat.token"),
                value: tokenStatus() ?? "—",
              },
            ]}
          />
          <ResultNotice result={props.snapshot.compatToken} />
          <Show when={props.snapshot.compatRoute}>
            {(route) => <Capabilities route={route()} />}
          </Show>
        </Card>

        <Card class="av-cloud-card av-cloud-card-compact">
          <CardHeader
            title={
              <IconTitle
                icon={<KeyRound size={18} />}
                label={t("cloudResources.catalog.title")}
              />
            }
            subtitle={t("cloudResources.catalog.subtitle")}
            actions={
              <Badge
                tone={
                  props.snapshot.catalog.summary.missing === 0 ? "ok" : "warn"
                }
              >
                {props.snapshot.catalog.summary.configured}/
                {props.snapshot.catalog.summary.total}
              </Badge>
            }
          />
          <KVList
            items={[
              {
                label: t("cloudResources.catalog.configured"),
                value: String(props.snapshot.catalog.summary.configured),
              },
              {
                label: t("cloudResources.catalog.missing"),
                value: String(props.snapshot.catalog.summary.missing),
              },
              {
                label: t("cloudResources.catalog.generated"),
                value: formatDateTime(props.snapshot.catalog.generatedAt),
              },
            ]}
          />
          <CardSection>
            <ChipBlock
              title={t("cloudResources.catalog.extensions")}
              values={props.snapshot.catalog.extensions.map(
                (extension) => extension.id,
              )}
            />
          </CardSection>
        </Card>
      </div>
    </div>
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

function Capabilities(props: {
  readonly route: CloudExtensionCatalogItem;
}): JSX.Element {
  return (
    <CardSection>
      <ChipBlock
        title={t("cloudResources.capabilities")}
        values={props.route.capabilities}
      />
    </CardSection>
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
  route: CloudExtensionCatalogItem | undefined,
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
