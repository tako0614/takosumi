/**
 * Service detail (`/services/:id` + tab routes) — one service. The primary tabs
 * stay focused on using/opening the service and reviewing updates; source,
 * provider mapping, and delete options remain reachable from advanced manage
 * routes instead of occupying the everyday tab strip.
 *
 * The friendly layer leads: open the service, check its status, then opt into
 * updates/settings when needed. All mutations still route through the same
 * control-plane actions (plan / destroy plan / rollback plan / backup / put
 * profile).
 */
import "../../styles/wave-a.css";
import "../../styles/wave-b.css";
import "../../styles/app-views.css";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  Match,
  Show,
  Switch,
} from "solid-js";
import { A, useNavigate, useParams } from "@solidjs/router";
import {
  Archive,
  ArrowLeft,
  ExternalLink,
  RotateCcw,
  Settings2,
} from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import {
  type BackupRecord,
  type ActivityEvent,
  type ControlApiError,
  type InstallationProviderConnectionBinding,
  type InstallationProviderConnectionBindings,
  type ProviderConnection,
  createDeploymentRollbackPlan,
  createInstallationBackup,
  destroyPlanInstallation,
  extractRunId,
  getInstallationProviderConnectionSet,
  getInstallation,
  getSpaceGraph,
  listActivity,
  listDeployments,
  listProviderConnections,
  listSources,
  planInstallation,
  putInstallationProviderConnectionSet,
} from "../../lib/control-api.ts";
import { createAction } from "../account/lib/action.tsx";
import {
  deploymentStatusLabel,
  deploymentTone,
  installationStatusLabel,
  installationTone,
  operationLabel,
  runStatusLabel,
  runTone,
} from "../../lib/labels.ts";
import {
  effectiveInstallationStatus,
  isUrlString,
  launchUrlFromOutputs,
  outputLabel,
} from "../../lib/installations-ui.ts";
import { formatDateTime, setDocumentTitle, t } from "../../i18n/index.ts";
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Input,
  KVList,
  PageHeader,
  Select,
  Skeleton,
  StatusBadge,
  Tabs,
} from "../../components/ui/index.ts";

type TabId = "overview" | "deploys" | "settings" | "danger";

export default function AppDetailView() {
  return <Page title={t("app.installationSub")}>{() => <Inner />}</Page>;
}

function Inner() {
  const params = useParams();
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const installationId = () => params.id ?? "";
  const tab = (): TabId => {
    const raw = params.tab;
    return raw === "deploys" || raw === "settings" || raw === "danger"
      ? raw
      : "overview";
  };

  const [installation, { refetch: refetchInstallation }] = createResource(
    installationId,
    getInstallation,
  );
  const spaceId = () => installation()?.spaceId;
  const [profile, { refetch: refetchProfile }] = createResource(
    installationId,
    getInstallationProviderConnectionSet,
  );
  const [sources] = createResource(spaceId, listSources);
  const [deployments] = createResource(installationId, listDeployments);
  const [graph] = createResource(spaceId, getSpaceGraph);
  const [providerConnections] = createResource(
    spaceId,
    listProviderConnections,
  );
  const [activity] = createResource(spaceId, (id) => listActivity(id, 100));

  const source = createMemo(() =>
    (sources() ?? []).find((item) => item.id === installation()?.sourceId),
  );
  const producers = createMemo(() =>
    dependencyRows(installation(), graph(), "producer"),
  );
  const consumers = createMemo(() =>
    dependencyRows(installation(), graph(), "consumer"),
  );

  createEffect(() => {
    const inst = installation();
    if (inst) {
      setDocumentTitle(inst.name);
      return;
    }
    if (installation.error) {
      setDocumentTitle(t("app.notFound"));
    }
  });

  const deploymentHistory = createMemo(() =>
    [...(deployments() ?? [])].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    ),
  );
  const currentDeployment = createMemo(() => {
    const list = deploymentHistory();
    const currentId = installation()?.currentDeploymentId;
    return (
      (currentId && list.find((d) => d.id === currentId)) ||
      list[0] ||
      undefined
    );
  });
  const publicOutputs = createMemo(() =>
    Object.entries(currentDeployment()?.outputsPublic ?? {}),
  );
  const publicLinkOutputs = createMemo(() =>
    publicOutputs().filter(([, value]) => isUrlString(value)),
  );
  const otherPublicOutputs = createMemo(() =>
    publicOutputs().filter(([, value]) => !isUrlString(value)),
  );
  const launchUrl = createMemo(() =>
    launchUrlFromOutputs(currentDeployment()?.outputsPublic ?? {}),
  );

  /** Recent run/release events for THIS app (activity carries metadata.installationId). */
  const recentActivity = createMemo(() =>
    (activity() ?? [])
      .filter(
        (event) =>
          event.metadata.installationId === installationId() &&
          (event.targetType === "run" ||
            event.action.startsWith("release_activation.")),
      )
      .slice(0, 8),
  );

  // --- actions ---------------------------------------------------------------
  const plan = createAction(async () => {
    const envelope = await planInstallation(installationId());
    const runId = extractRunId(envelope);
    if (runId) navigate(`/runs/${runId}`);
  });
  const destroyPlan = createAction(async () => {
    const envelope = await destroyPlanInstallation(installationId());
    const runId = extractRunId(envelope);
    if (runId) navigate(`/runs/${runId}`);
  });
  const backup = createAction(async (): Promise<BackupRecord> => {
    return await createInstallationBackup(installationId());
  });
  const rollback = createAction(async (deploymentId: string) => {
    const envelope = await createDeploymentRollbackPlan(deploymentId);
    const runId = extractRunId(envelope);
    if (runId) navigate(`/runs/${runId}`);
  });

  const confirmDestroy = async () => {
    const ok = await confirm({
      title: t("app.danger.destroyTitle"),
      message: t("app.danger.destroyBody"),
      confirmText: t("app.danger.destroyCta"),
      danger: true,
    });
    if (!ok) return;
    void destroyPlan.run();
  };

  const tabItems = () => {
    const base = `/services/${encodeURIComponent(installationId())}`;
    return [
      { href: base, label: t("app.tab.overview"), end: true },
      { href: `${base}/deploys`, label: t("app.tab.deploys") },
    ];
  };

  return (
    <AppShell>
      <Switch>
        <Match when={installation.loading}>
          <Card>
            <Skeleton variant="block" />
          </Card>
        </Match>
        <Match when={installation.error}>
          <EmptyState
            title={t("app.notFound")}
            message={(installation.error as ControlApiError).message}
            action={
              <Button
                variant="secondary"
                href="/"
                icon={<ArrowLeft size={16} />}
              >
                {t("app.backToList")}
              </Button>
            }
          />
        </Match>
        <Match when={installation()}>
          {(inst) => (
            <>
              <PageHeader
                eyebrow={t("app.installationSub")}
                title={
                  <span class="wa-title-row">
                    {inst().name}
                    <StatusBadge
                      status={effectiveInstallationStatus(inst())}
                      label={installationStatusLabel}
                      tone={installationTone}
                    />
                  </span>
                }
                actions={
                  <div class="av-actions">
                    <Button variant="ghost" href="/">
                      {t("app.backToList")}
                    </Button>
                    <Show when={launchUrl()}>
                      {(url) => (
                        <Button
                          variant="primary"
                          href={url()}
                          target="_blank"
                          rel="noreferrer noopener"
                          icon={<ExternalLink size={16} />}
                        >
                          {t("apps.openApp")}
                        </Button>
                      )}
                    </Show>
                  </div>
                }
              />

              <Tabs items={tabItems()} aria-label="Service sections" />

              <div class="wa-stack">
                <Switch>
                  <Match when={tab() === "overview"}>
                    <OverviewTab
                      publicLinkOutputs={publicLinkOutputs()}
                      otherPublicOutputs={otherPublicOutputs()}
                      hasDeployment={currentDeployment() !== undefined}
                      outputsLoading={deployments.loading}
                      producers={producers()}
                      consumers={consumers()}
                    />
                  </Match>
                  <Match when={tab() === "deploys"}>
                    <DeploysTab
                      loading={deployments.loading}
                      error={
                        deployments.error
                          ? (deployments.error as ControlApiError).message
                          : undefined
                      }
                      history={deploymentHistory()}
                      currentId={currentDeployment()?.id}
                      rollbackBusy={rollback.busy()}
                      onRollback={(id) => void rollback.run(id)}
                      rollbackError={rollback.error()}
                      backupBusy={backup.busy()}
                      onBackup={() => void backup.run()}
                      backupError={backup.error()}
                      backupResult={backup.result()}
                      recentActivity={recentActivity()}
                      reviewBusy={plan.busy()}
                      onReview={() => void plan.run()}
                      reviewError={plan.error()}
                      settingsHref={`/services/${encodeURIComponent(installationId())}/settings`}
                    />
                  </Match>
                  <Match when={tab() === "settings"}>
                    <SettingsTab
                      source={source()}
                      providerConnections={profile()?.connections}
                      availableProviderConnections={providerConnections() ?? []}
                      installationId={installationId()}
                      dangerHref={`/services/${encodeURIComponent(installationId())}/danger`}
                      onSaved={() =>
                        void Promise.all([
                          refetchProfile(),
                          refetchInstallation(),
                        ])
                      }
                    />
                  </Match>
                  <Match when={tab() === "danger"}>
                    <Card>
                      <CardHeader
                        title={t("app.danger.destroyTitle")}
                        subtitle={t("app.danger.destroyBody")}
                      />
                      <div class="wa-form-actions">
                        <Button
                          variant="danger"
                          type="button"
                          disabled={destroyPlan.busy()}
                          busy={destroyPlan.busy()}
                          onClick={() => void confirmDestroy()}
                        >
                          {t("app.danger.destroyCta")}
                        </Button>
                      </div>
                      <Show when={destroyPlan.error()}>
                        {(m) => (
                          <p class="wa-error" role="alert">
                            {m()}
                          </p>
                        )}
                      </Show>
                    </Card>
                  </Match>
                </Switch>
              </div>
            </>
          )}
        </Match>
      </Switch>
    </AppShell>
  );
}

// === overview ================================================================

interface DependencyRow {
  readonly id: string;
  readonly name: string;
}

function dependencyRows(
  inst: { readonly id: string } | undefined,
  graph:
    | {
        readonly nodes: readonly { installationId: string; name: string }[];
        readonly edges: readonly {
          id: string;
          producerInstallationId: string;
          consumerInstallationId: string;
          outputs: Record<string, { from: string; to: string }>;
        }[];
      }
    | undefined,
  side: "producer" | "consumer",
): readonly DependencyRow[] {
  if (!inst || !graph) return [];
  const names = new Map(
    graph.nodes.map((node) => [node.installationId, node.name]),
  );
  return graph.edges
    .filter((edge) =>
      side === "producer"
        ? edge.consumerInstallationId === inst.id
        : edge.producerInstallationId === inst.id,
    )
    .map((edge) => {
      const otherId =
        side === "producer"
          ? edge.producerInstallationId
          : edge.consumerInstallationId;
      return {
        id: edge.id,
        name: names.get(otherId) ?? otherId,
      };
    });
}

function OverviewTab(props: {
  readonly publicLinkOutputs: readonly [string, unknown][];
  readonly otherPublicOutputs: readonly [string, unknown][];
  readonly hasDeployment: boolean;
  readonly outputsLoading: boolean;
  readonly producers: readonly DependencyRow[];
  readonly consumers: readonly DependencyRow[];
}) {
  return (
    <>
      <Card>
        <CardHeader
          title={t("app.outputs.title")}
          subtitle={t("app.outputs.subtitle")}
        />
        <Switch>
          <Match when={props.outputsLoading}>
            <p class="muted">{t("common.loading")}</p>
          </Match>
          <Match when={props.publicLinkOutputs.length === 0}>
            <p class="muted">
              {props.hasDeployment
                ? t("app.outputs.none")
                : t("app.outputs.empty")}
            </p>
          </Match>
          <Match when={props.publicLinkOutputs.length > 0}>
            <KVList
              items={props.publicLinkOutputs.map(([name, value]) => ({
                label: outputLabel(name),
                value: <OutputValue value={value} />,
              }))}
            />
          </Match>
        </Switch>
        <Show when={props.otherPublicOutputs.length > 0}>
          <details class="wb-disclosure">
            <summary>{t("app.outputs.valuesTitle")}</summary>
            <KVList
              items={props.otherPublicOutputs.map(([name, value]) => ({
                label: outputLabel(name),
                value: <OutputValue value={value} />,
              }))}
            />
          </details>
        </Show>
      </Card>

      <Show when={props.producers.length > 0 || props.consumers.length > 0}>
        <details class="wb-disclosure">
          <summary>{t("app.deps.title")}</summary>
          <Card>
            <div class="wa-dep-columns">
              <DependencyList
                title={t("app.deps.dependsOn")}
                rows={props.producers}
              />
              <DependencyList
                title={t("app.deps.usedBy")}
                rows={props.consumers}
              />
            </div>
          </Card>
        </details>
      </Show>
    </>
  );
}

function DependencyList(props: {
  readonly title: string;
  readonly rows: readonly DependencyRow[];
}) {
  return (
    <div>
      <h4>{props.title}</h4>
      <Show
        when={props.rows.length > 0}
        fallback={<p class="muted">{t("common.none")}</p>}
      >
        <ul class="wa-dep-list">
          <For each={props.rows}>
            {(row) => (
              <li>
                <code>{row.name}</code>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

/** Public output value: http(s) → prominent link; otherwise monospace text. */
function OutputValue(props: { readonly value: unknown }): JSX.Element {
  return (
    <Switch fallback={<code>{stringifyOutput(props.value)}</code>}>
      <Match when={isUrlString(props.value)}>
        <span class="wa-output-url">
          <Button
            variant="primary"
            size="sm"
            href={props.value as string}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t("app.output.openPublicLink")}
          </Button>
          <details class="wb-inline-details">
            <summary>{t("app.output.url")}</summary>
            <code>{props.value as string}</code>
          </details>
        </span>
      </Match>
      <Match when={typeof props.value === "string"}>
        <code>{props.value as string}</code>
      </Match>
    </Switch>
  );
}

function stringifyOutput(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// === deploys =================================================================

function DeploysTab(props: {
  readonly loading: boolean;
  readonly error?: string;
  readonly history: readonly {
    readonly id: string;
    readonly status: string;
    readonly stateGeneration: number;
    readonly createdAt: string;
  }[];
  readonly currentId?: string;
  readonly rollbackBusy: boolean;
  readonly onRollback: (deploymentId: string) => void;
  readonly rollbackError: string | null;
  readonly backupBusy: boolean;
  readonly onBackup: () => void;
  readonly backupError: string | null;
  readonly backupResult: BackupRecord | undefined;
  readonly recentActivity: readonly ActivityEvent[];
  readonly reviewBusy: boolean;
  readonly onReview: () => void;
  readonly reviewError: string | null;
  readonly settingsHref: string;
}) {
  return (
    <>
      <Card>
        <CardHeader
          title={t("app.deploys.reviewTitle")}
          subtitle={t("app.deploys.reviewSubtitle")}
          actions={
            <div class="av-actions">
              <Button
                variant="primary"
                size="sm"
                type="button"
                disabled={props.reviewBusy}
                busy={props.reviewBusy}
                onClick={() => props.onReview()}
              >
                {t("apps.reviewChanges")}
              </Button>
            </div>
          }
        />
        <Show when={props.reviewError}>
          {(m) => (
            <p class="wa-error" role="alert">
              {m()}
            </p>
          )}
        </Show>
        <Show when={props.backupResult}>
          {(record) => (
            <div class="wa-notice">
              {t("app.deploys.backupCreated")}
              <details class="wb-inline-details">
                <summary>{t("app.deploys.backupSupportRef")}</summary>
                <code>{record().id}</code>
              </details>
            </div>
          )}
        </Show>
        <Show when={props.backupError}>
          {(m) => (
            <p class="wa-error" role="alert">
              {m()}
            </p>
          )}
        </Show>
        <Show when={props.rollbackError}>
          {(m) => (
            <p class="wa-error" role="alert">
              {m()}
            </p>
          )}
        </Show>
        <details class="wb-disclosure">
          <summary>{t("app.deploys.title")}</summary>
          <Switch>
            <Match when={props.loading}>
              <p class="muted">{t("common.loading")}</p>
            </Match>
            <Match when={props.error}>
              <p class="wa-error">
                {t("common.fetchFailed", { message: props.error! })}
              </p>
            </Match>
            <Match when={props.history.length === 0}>
              <p class="muted">{t("app.deploys.empty")}</p>
            </Match>
            <Match when={props.history.length > 0}>
              <ul class="wa-deploy-history">
                <For each={props.history}>
                  {(deployment) => {
                    const isCurrent = () => deployment.id === props.currentId;
                    return (
                      <li class="wa-deploy-row">
                        <span class="wa-deploy-when">
                          {formatDateTime(deployment.createdAt)}
                        </span>
                        <Show when={isCurrent()}>
                          <Badge tone="ok">
                            {t("status.deployment.active")}
                          </Badge>
                        </Show>
                        <Show when={!isCurrent()}>
                          <StatusBadge
                            status={deployment.status}
                            label={deploymentStatusLabel}
                            tone={deploymentTone}
                          />
                        </Show>
                        <Show when={!isCurrent()}>
                          <details class="wb-inline-details">
                            <summary>{t("app.deploys.restoreMenu")}</summary>
                            <Button
                              variant="secondary"
                              size="sm"
                              type="button"
                              icon={<RotateCcw size={14} />}
                              disabled={props.rollbackBusy}
                              onClick={() => props.onRollback(deployment.id)}
                            >
                              {t("app.deploys.restore")}
                            </Button>
                          </details>
                        </Show>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </Match>
          </Switch>
        </details>
        <details class="wb-disclosure">
          <summary>{t("app.deploys.advancedActions")}</summary>
          <p class="muted">{t("app.deploys.advancedActionsBody")}</p>
          <div class="wa-form-actions">
            <Button
              variant="secondary"
              size="sm"
              href={props.settingsHref}
              icon={<Settings2 size={14} />}
            >
              {t("app.settings.openCta")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              icon={<Archive size={14} />}
              disabled={props.backupBusy}
              busy={props.backupBusy}
              onClick={() => props.onBackup()}
            >
              {t("app.deploys.backup")}
            </Button>
          </div>
        </details>
      </Card>

      <Show when={props.recentActivity.length > 0}>
        <details class="wb-disclosure">
          <summary>{t("app.recentActivity.title")}</summary>
          <Card>
            <ul class="av-run-list">
              <For each={props.recentActivity}>
                {(event) => (
                  <li class="av-run-row">
                    <span class="av-run-action">
                      {activityEventTitle(event)}
                    </span>
                    <ActivityEventBadge action={event.action} />
                    <span class="muted">{formatDateTime(event.createdAt)}</span>
                    <Show when={activityRunId(event)}>
                      {(runId) => (
                        <A href={`/runs/${encodeURIComponent(runId())}`}>
                          {t("app.recentActivity.open")} →
                        </A>
                      )}
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Card>
        </details>
      </Show>
    </>
  );
}

function activityEventTitle(event: ActivityEvent): string {
  if (event.action.startsWith("release_activation.")) {
    return t("app.recentActivity.releaseActivation");
  }
  return operationLabel(
    typeof event.metadata.operation === "string"
      ? event.metadata.operation
      : undefined,
  );
}

function activityRunId(event: ActivityEvent): string | undefined {
  if (event.runId) return event.runId;
  if (event.targetType === "run") return event.targetId;
  const applyRunId = event.metadata.applyRunId;
  return typeof applyRunId === "string" ? applyRunId : undefined;
}

/** Compact badge for run.* / release_activation.* activity verbs. */
function ActivityEventBadge(props: { readonly action: string }) {
  const status = () => {
    switch (props.action) {
      case "run.failed":
      case "release_activation.failed":
        return "failed";
      case "run.applied":
      case "release_activation.succeeded":
        return "succeeded";
      case "run.plan_created":
        return "waiting_approval";
      case "run.approved":
      case "release_activation.pending":
        return "running";
      default:
        return undefined;
    }
  };
  return (
    <Show when={status()}>
      {(s) => (
        <StatusBadge status={s()} label={runStatusLabel} tone={runTone} />
      )}
    </Show>
  );
}

// === settings ================================================================

interface InstallationProviderConnectionRow {
  readonly provider: string;
  readonly alias: string;
  readonly connectionId: string;
}

function providerConnectionToRow(
  binding: InstallationProviderConnectionBinding,
): InstallationProviderConnectionRow {
  return {
    provider: binding.provider,
    alias: binding.alias ?? "",
    connectionId: binding.connectionId,
  };
}

function canonicalProvider(provider: string): string {
  return provider.toLowerCase().trim();
}

function providerTail(provider: string): string {
  const normalized = canonicalProvider(provider);
  return normalized.split("/").at(-1) ?? normalized;
}

function sameProviderFamily(
  requiredProvider: string,
  candidateProvider: string,
) {
  const required = canonicalProvider(requiredProvider);
  const candidate = canonicalProvider(candidateProvider);
  if (required === candidate) return true;
  return providerTail(required) === providerTail(candidate);
}

function readyProviderConnectionsForProvider(
  provider: string,
  providerConnections: readonly ProviderConnection[],
): readonly ProviderConnection[] {
  return providerConnections.filter(
    (connection) =>
      connection.status === "ready" &&
      sameProviderFamily(provider, connection.providerSource),
  );
}

function providerConnectionLabel(
  providerConnection: ProviderConnection,
): string {
  return providerConnection.displayName || providerConnection.providerSource;
}

function providerDisplayName(provider: string): string {
  const name = providerTail(provider).trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : provider;
}

function boundConnectionLabel(
  row: InstallationProviderConnectionRow,
  providerConnections: readonly ProviderConnection[],
): string {
  const match = providerConnections.find(
    (connection) => connection.id === row.connectionId,
  );
  return match ? providerConnectionLabel(match) : t("common.none");
}

function boundProviderLabel(row: InstallationProviderConnectionRow): string {
  if (!row.provider.trim()) return t("app.bindings.providerPlaceholder");
  return row.alias
    ? `${providerDisplayName(row.provider)} (${row.alias})`
    : providerDisplayName(row.provider);
}

function buildProviderConnections(
  rows: readonly InstallationProviderConnectionRow[],
  options: {
    readonly providerConnections: readonly ProviderConnection[];
  },
):
  | { readonly connections: InstallationProviderConnectionBindings }
  | { readonly error: string } {
  const connections: InstallationProviderConnectionBinding[] = [];
  for (const [index, row] of rows.entries()) {
    const provider = row.provider.trim();
    if (!provider) {
      return { error: t("app.bindings.errorProvider", { index: index + 1 }) };
    }
    const binding: {
      provider: string;
      alias?: string;
      connectionId: string;
    } = { provider, connectionId: row.connectionId.trim() };
    const alias = row.alias.trim();
    if (alias) binding.alias = alias;
    const validConnections = readyProviderConnectionsForProvider(
      provider,
      options.providerConnections,
    );
    if (
      !binding.connectionId ||
      !validConnections.some(
        (connection) => connection.id === binding.connectionId,
      )
    ) {
      return { error: t("app.bindings.errorConnection", { provider }) };
    }
    connections.push(binding);
  }
  return { connections };
}

function SettingsTab(props: {
  readonly source:
    | {
        readonly name: string;
        readonly url: string;
        readonly defaultRef: string;
        readonly defaultPath: string;
        readonly status: string;
      }
    | undefined;
  readonly providerConnections:
    | InstallationProviderConnectionBindings
    | undefined;
  readonly availableProviderConnections: readonly ProviderConnection[];
  readonly installationId: string;
  readonly dangerHref: string;
  readonly onSaved: () => void;
}) {
  const [rows, setRows] = createSignal<InstallationProviderConnectionRow[]>([]);
  const [formError, setFormError] = createSignal<string | null>(null);

  createEffect(() => {
    const providerConnections = props.providerConnections;
    if (!providerConnections) return;
    setRows(providerConnections.map(providerConnectionToRow));
  });

  const update = (
    index: number,
    patch: Partial<InstallationProviderConnectionRow>,
  ) =>
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );

  const saveProfile = createAction(async () => {
    setFormError(null);
    const providerConnections = buildProviderConnections(rows(), {
      providerConnections: props.availableProviderConnections,
    });
    if ("error" in providerConnections) {
      setFormError(providerConnections.error);
      return;
    }
    await putInstallationProviderConnectionSet(
      props.installationId,
      providerConnections.connections,
    );
    props.onSaved();
  });

  return (
    <>
      <details class="wb-disclosure">
        <summary>{t("app.bindings.title")}</summary>
        <Card>
          <CardHeader
            title={t("app.bindings.title")}
            subtitle={t("app.bindings.subtitle")}
          />
          <Show
            when={rows().length > 0}
            fallback={<p class="muted">{t("app.bindings.none")}</p>}
          >
            <KVList
              items={rows().map((row) => ({
                label: boundProviderLabel(row),
                value: boundConnectionLabel(
                  row,
                  props.availableProviderConnections,
                ),
              }))}
            />
          </Show>
          <details class="wb-disclosure">
            <summary>{t("app.bindings.editAdvanced")}</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void saveProfile.run();
              }}
            >
              <div class="wa-binding-grid">
                <For each={rows()}>
                  {(row, index) => {
                    const readyConnections = () =>
                      readyProviderConnectionsForProvider(
                        row.provider,
                        props.availableProviderConnections,
                      );
                    return (
                      <div class="wa-binding-row">
                        <div class="wa-binding-head">
                          <strong>{boundProviderLabel(row)}</strong>
                        </div>
                        <div class="wa-binding-controls">
                          <Select
                            value={row.connectionId}
                            onChange={(e) =>
                              update(index(), {
                                connectionId: e.currentTarget.value,
                              })
                            }
                          >
                            <option value="" selected={row.connectionId === ""}>
                              {t("app.bindings.selectConnection")}
                            </option>
                            <For each={readyConnections()}>
                              {(connection) => (
                                <option
                                  value={connection.id}
                                  selected={connection.id === row.connectionId}
                                >
                                  {providerConnectionLabel(connection)}
                                </option>
                              )}
                            </For>
                          </Select>
                          <Button
                            variant="ghost"
                            size="sm"
                            type="button"
                            onClick={() =>
                              setRows((prev) =>
                                prev.filter((_, i) => i !== index()),
                              )
                            }
                          >
                            {t("app.bindings.remove")}
                          </Button>
                        </div>
                        <details class="wb-inline-details">
                          <summary>{t("app.bindings.technicalTarget")}</summary>
                          <div class="wa-binding-head">
                            <Input
                              value={row.provider}
                              onInput={(e) =>
                                update(index(), {
                                  provider: e.currentTarget.value,
                                  connectionId: "",
                                })
                              }
                              placeholder={t(
                                "app.bindings.providerPlaceholder",
                              )}
                            />
                            <Input
                              value={row.alias}
                              onInput={(e) =>
                                update(index(), {
                                  alias: e.currentTarget.value,
                                })
                              }
                              placeholder={t("app.bindings.aliasPlaceholder")}
                            />
                          </div>
                        </details>
                      </div>
                    );
                  }}
                </For>
              </div>
              <div class="wa-form-actions">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() =>
                    setRows((prev) => [
                      ...prev,
                      {
                        provider: "",
                        alias: "",
                        connectionId: "",
                      },
                    ])
                  }
                >
                  {t("app.bindings.add")}
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={saveProfile.busy()}
                  busy={saveProfile.busy()}
                >
                  {saveProfile.busy() ? t("common.saving") : t("common.save")}
                </Button>
              </div>
              <Show when={formError()}>
                {(m) => (
                  <p class="wa-error" role="alert">
                    {m()}
                  </p>
                )}
              </Show>
              <Show when={saveProfile.error()}>
                {(m) => (
                  <p class="wa-error" role="alert">
                    {m()}
                  </p>
                )}
              </Show>
            </form>
          </details>
        </Card>
      </details>

      <details class="wb-disclosure">
        <summary>{t("app.settings.supportDetails")}</summary>
        <Card>
          <CardHeader
            title={t("app.settings.supportDetails")}
            subtitle={t("app.source.supportBody")}
          />
          <details class="wb-inline-details">
            <summary>{t("app.source.title")}</summary>
            <Show
              when={props.source}
              fallback={<p class="muted">{t("app.source.loading")}</p>}
            >
              {(src) => (
                <KVList
                  items={[
                    { label: t("app.source.name"), value: src().name },
                    {
                      label: t("app.source.url"),
                      value: <code>{src().url}</code>,
                    },
                    {
                      label: t("app.source.refPath"),
                      value: (
                        <>
                          <code>{src().defaultRef}</code>
                          <span class="muted"> / </span>
                          <code>{src().defaultPath}</code>
                        </>
                      ),
                    },
                  ]}
                />
              )}
            </Show>
          </details>
        </Card>
      </details>

      <details class="wb-disclosure">
        <summary>{t("app.tab.danger")}</summary>
        <Card>
          <CardHeader
            title={t("app.settings.removeTitle")}
            subtitle={t("app.settings.removeBody")}
            actions={
              <Button variant="secondary" href={props.dangerHref}>
                {t("app.settings.removeCta")}
              </Button>
            }
          />
        </Card>
      </details>
    </>
  );
}
