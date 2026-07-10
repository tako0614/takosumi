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
  Index,
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
  RefreshCw,
  RotateCcw,
  Settings2,
  Trash2,
} from "lucide-solid";
import {
  installExperienceInitialSecret,
  installExperiencePublicEndpoint,
  installExperienceServiceNameVariable,
} from "takosumi-contract";
import Page from "../account/components/auth/Page.tsx";
import {
  type BackupRecord,
  type ActivityEvent,
  type ControlApiError,
  type InstallConfig,
  type CapsuleProviderConnectionBinding,
  type CapsuleProviderConnectionBindings,
  type ProviderConnection,
  createDeploymentRollbackPlan,
  createCapsuleBackup,
  deleteCapsule,
  extractRunId,
  getDeployment,
  getInstallConfig,
  getCapsuleProviderConnectionSet,
  getCapsule,
  getWorkspaceGraph,
  listActivity,
  listDeployments,
  listProviderConnections,
  listSources,
  getCapsuleUsageSummary,
  planCapsule,
  patchInstallConfig,
  putCapsuleProviderConnectionSet,
  setCapsuleAutoUpdate,
} from "../../lib/control-api.ts";
import { formatUsdMicros } from "../../lib/billing-format.ts";
import { createAction } from "../account/lib/action.tsx";
import {
  deploymentStatusLabel,
  deploymentTone,
  capsuleStatusLabel,
  capsuleTone,
  operationLabel,
  runStatusLabel,
  runTone,
} from "../../lib/labels.ts";
import {
  effectiveCapsuleStatus,
  isDeploymentPubliclyOpenable,
  isUrlString,
  launchUrlFromDeployment,
  releaseActivationStatusForDeployment,
  outputLabel,
} from "../../lib/capsules-ui.ts";
import {
  formatDateTime,
  locale,
  setDocumentTitle,
  t,
} from "../../i18n/index.ts";
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  FormField,
  EmptyState,
  Input,
  KVList,
  PageHeader,
  Select,
  Skeleton,
  StatusBadge,
  Tabs,
  Textarea,
  Toast,
} from "../../components/ui/index.ts";
import type { JsonValue } from "takosumi-contract";
import { clearCapsuleListCache } from "../../lib/capsule-list.ts";
import { clearCurrentStateVersionCache } from "../../lib/current-state-versions.ts";
import { clearDashboardOverviewCache } from "../../lib/dashboard-overview.ts";

type TabId = "overview" | "deploys" | "settings" | "danger";

export default function AppDetailView() {
  return <Page title={t("app.capsuleSub")}>{() => <Inner />}</Page>;
}

function Inner() {
  const params = useParams();
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const capsuleId = () => params.id ?? "";
  const tab = (): TabId => {
    const raw = params.tab;
    return raw === "deploys" || raw === "settings" || raw === "danger"
      ? raw
      : "overview";
  };

  const [capsule, { refetch: refetchCapsule }] = createResource(
    capsuleId,
    getCapsule,
  );
  const workspaceId = () => capsule()?.workspaceId;
  const settingsCapsuleId = () => (tab() === "settings" ? capsuleId() : null);
  const settingsWorkspaceId = () =>
    tab() === "settings" ? (workspaceId() ?? null) : null;
  const deploysCapsuleId = () => (tab() === "deploys" ? capsuleId() : null);
  const graphWorkspaceId = () =>
    tab() === "overview" ? (workspaceId() ?? null) : null;
  const currentStateVersionId = () =>
    capsule()?.currentStateVersionId ?? capsule()?.currentDeploymentId ?? null;
  const [profile, { refetch: refetchProfile }] = createResource(
    settingsCapsuleId,
    getCapsuleProviderConnectionSet,
  );
  const settingsInstallConfigId = () =>
    tab() === "settings" ? (capsule()?.installConfigId ?? null) : null;
  const [installConfig, { refetch: refetchInstallConfig }] = createResource(
    settingsInstallConfigId,
    getInstallConfig,
  );
  const [sources] = createResource(settingsWorkspaceId, listSources);
  const [deployments] = createResource(deploysCapsuleId, listDeployments);
  const [currentStateVersion] = createResource(
    currentStateVersionId,
    getDeployment,
  );
  const [graph] = createResource(graphWorkspaceId, getWorkspaceGraph);
  const [providerConnections] = createResource(
    settingsWorkspaceId,
    listProviderConnections,
  );
  const activityWorkspaceId = () => {
    const id = workspaceId();
    if (!id) return null;
    return tab() === "deploys" || currentDeployment() ? id : null;
  };
  const [activity] = createResource(activityWorkspaceId, (id) =>
    listActivity(id, 100),
  );

  const source = createMemo(() =>
    (sources() ?? []).find((item) => item.id === capsule()?.sourceId),
  );
  const producers = createMemo(() =>
    dependencyRows(capsule(), graph(), "producer"),
  );
  const consumers = createMemo(() =>
    dependencyRows(capsule(), graph(), "consumer"),
  );

  createEffect(() => {
    const inst = capsule();
    if (inst) {
      setDocumentTitle(inst.name);
      return;
    }
    if (capsule.error) {
      setDocumentTitle(t("app.notFound"));
    }
  });

  const deploymentHistory = createMemo(() =>
    [...(deployments() ?? [])].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    ),
  );
  const currentDeployment = createMemo(() => {
    const current = currentStateVersion();
    if (current) return current;
    const list = deploymentHistory();
    const currentId =
      capsule()?.currentStateVersionId ?? capsule()?.currentDeploymentId;
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
  const releaseActivationStatus = createMemo(() =>
    releaseActivationStatusForDeployment(
      currentDeployment(),
      activity() ?? [],
      capsuleId(),
    ),
  );
  const serviceOpenable = createMemo(
    () =>
      capsule()?.status !== "destroyed" &&
      isDeploymentPubliclyOpenable(
        currentDeployment(),
        activity() ?? [],
        capsuleId(),
      ),
  );
  const launchUrl = createMemo(() =>
    launchUrlFromDeployment(currentDeployment(), activity() ?? [], capsuleId()),
  );

  /** Recent run/release events for THIS app (activity carries metadata.capsuleId). */
  const recentActivity = createMemo(() =>
    (activity() ?? [])
      .filter(
        (event) =>
          activityBelongsToCapsule(event, capsuleId()) &&
          (event.targetType === "run" ||
            event.action.startsWith("release_activation.")),
      )
      .slice(0, 8),
  );

  // --- actions ---------------------------------------------------------------
  const plan = createAction(async () => {
    const envelope = await planCapsule(capsuleId());
    const runId = extractRunId(envelope);
    if (runId) navigate(`/runs/${runId}`);
  });
  // 1-tap update: same plan run, but the run screen shows the App-Store-style
  // progress and auto-continues a clean plan to apply (?auto=update).
  const update = createAction(async () => {
    const envelope = await planCapsule(capsuleId());
    const runId = extractRunId(envelope);
    if (runId) navigate(`/runs/${runId}?auto=update`);
  });
  const autoUpdateToggle = createAction(async () => {
    await setCapsuleAutoUpdate(capsuleId(), capsule()?.autoUpdate !== true);
    await refetchCapsule();
  });
  // Per-app showback: rendered only when usage was actually recorded, so
  // self-host with billing disabled never shows an empty money card.
  const [usageSummary] = createResource(capsuleId, (id) =>
    getCapsuleUsageSummary(id).catch(() => undefined),
  );
  const destroyPlan = createAction(async () => {
    const workspace = capsule()?.workspaceId;
    const envelope = await deleteCapsule(capsuleId());
    const runId = extractRunId(envelope);
    if (workspace) {
      clearCapsuleListCache(workspace);
      clearCurrentStateVersionCache(workspace);
      clearDashboardOverviewCache(workspace);
    }
    if (runId) {
      navigate(`/runs/${runId}`);
      return;
    }
    navigate("/services");
  });
  const backup = createAction(async (): Promise<BackupRecord> => {
    return await createCapsuleBackup(capsuleId());
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
    const base = `/services/${encodeURIComponent(capsuleId())}`;
    const items = [
      { href: base, label: t("app.tab.overview"), end: true },
      { href: `${base}/deploys`, label: t("app.tab.deploys") },
      { href: `${base}/settings`, label: t("app.tab.settings") },
    ];
    if (capsule()?.status !== "destroyed") {
      items.push({ href: `${base}/danger`, label: t("app.tab.danger") });
    }
    return items;
  };

  return (
    <>
      <Switch>
        <Match when={capsule.loading}>
          <Card>
            <Skeleton variant="block" />
          </Card>
        </Match>
        <Match when={capsule.error}>
          <EmptyState
            title={t("app.notFound")}
            message={(capsule.error as ControlApiError).message}
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
        <Match when={capsule()}>
          {(inst) => (
            <>
              <PageHeader
                eyebrow={t("app.capsuleSub")}
                title={
                  <span class="wa-title-row">
                    {inst().name}
                    <StatusBadge
                      status={effectiveCapsuleStatus(inst())}
                      label={capsuleStatusLabel}
                      tone={capsuleTone}
                    />
                  </span>
                }
                actions={
                  <div class="av-actions">
                    <Button variant="ghost" href="/">
                      {t("app.backToList")}
                    </Button>
                    <Show when={effectiveCapsuleStatus(inst()) === "stale"}>
                      <Button
                        variant="primary"
                        type="button"
                        busy={update.busy()}
                        disabled={update.busy()}
                        onClick={() => void update.run()}
                        icon={<RefreshCw size={16} />}
                      >
                        {t("app.updateNow")}
                      </Button>
                    </Show>
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
                    <Show when={inst().status !== "destroyed"}>
                      <Button
                        variant="danger"
                        type="button"
                        disabled={destroyPlan.busy()}
                        busy={destroyPlan.busy()}
                        onClick={() => void confirmDestroy()}
                        icon={<Trash2 size={16} />}
                      >
                        {t("common.delete")}
                      </Button>
                    </Show>
                  </div>
                }
              />

              <Show when={update.error() ?? destroyPlan.error()}>
                {(message) => <Toast tone="error">{message()}</Toast>}
              </Show>

              <Tabs items={tabItems()} aria-label="Service sections" />

              <div class="wa-stack">
                <Switch>
                  <Match when={tab() === "overview"}>
                    <OverviewTab
                      publicLinkOutputs={publicLinkOutputs()}
                      otherPublicOutputs={otherPublicOutputs()}
                      hasDeployment={currentDeployment() !== undefined}
                      serviceOpenable={serviceOpenable()}
                      releaseActivationStatus={releaseActivationStatus()}
                      outputsLoading={currentStateVersion.loading}
                      producers={producers()}
                      consumers={consumers()}
                    />
                    <Show
                      when={(usageSummary()?.eventCount ?? 0) > 0}
                    >
                      <Card>
                        <CardHeader
                          title={t("app.usage.title")}
                          subtitle={t("app.usage.body")}
                          actions={
                            <span class="wa-usage-amount">
                              {formatUsdMicros(usageSummary()!.usdMicros)}
                            </span>
                          }
                        />
                      </Card>
                    </Show>
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
                      settingsHref={`/services/${encodeURIComponent(capsuleId())}/settings`}
                    />
                  </Match>
                  <Match when={tab() === "settings"}>
                    <Card>
                      <CardHeader
                        title={t("app.autoUpdate.title")}
                        subtitle={t("app.autoUpdate.body")}
                        actions={
                          <Button
                            variant={
                              inst().autoUpdate === true
                                ? "secondary"
                                : "primary"
                            }
                            type="button"
                            busy={autoUpdateToggle.busy()}
                            disabled={autoUpdateToggle.busy()}
                            onClick={() => void autoUpdateToggle.run()}
                          >
                            {inst().autoUpdate === true
                              ? t("app.autoUpdate.disable")
                              : t("app.autoUpdate.enable")}
                          </Button>
                        }
                      />
                      <Show when={autoUpdateToggle.error()}>
                        {(message) => <Toast tone="error">{message()}</Toast>}
                      </Show>
                    </Card>
                    <SettingsTab
                      source={source()}
                      installConfig={installConfig()}
                      installConfigLoading={installConfig.loading}
                      providerConnections={profile()?.bindings}
                      availableProviderConnections={providerConnections() ?? []}
                      capsuleId={capsuleId()}
                      dangerHref={`/services/${encodeURIComponent(capsuleId())}/danger`}
                      onSaved={() =>
                        void Promise.all([
                          refetchProfile(),
                          refetchInstallConfig(),
                          refetchCapsule(),
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
    </>
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
        readonly nodes: readonly { capsuleId: string; name: string }[];
        readonly edges: readonly {
          id: string;
          producerCapsuleId: string;
          consumerCapsuleId: string;
          outputs: Record<string, { from: string; to: string }>;
        }[];
      }
    | undefined,
  side: "producer" | "consumer",
): readonly DependencyRow[] {
  if (!inst || !graph) return [];
  const names = new Map(graph.nodes.map((node) => [node.capsuleId, node.name]));
  return graph.edges
    .filter((edge) =>
      side === "producer"
        ? edge.consumerCapsuleId === inst.id
        : edge.producerCapsuleId === inst.id,
    )
    .map((edge) => {
      const otherId =
        side === "producer" ? edge.producerCapsuleId : edge.consumerCapsuleId;
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
  readonly serviceOpenable: boolean;
  readonly releaseActivationStatus:
    "not_required" | "pending" | "succeeded" | "failed";
  readonly outputsLoading: boolean;
  readonly producers: readonly DependencyRow[];
  readonly consumers: readonly DependencyRow[];
}) {
  return (
    <>
      <Card>
        <CardHeader
          title={t("app.outputs.title")}
          subtitle={
            props.releaseActivationStatus === "pending"
              ? t("app.outputs.activationPending")
              : props.releaseActivationStatus === "failed"
                ? t("app.outputs.activationFailed")
                : props.serviceOpenable
                  ? t("app.outputs.subtitle")
                  : t("app.outputs.deletedSubtitle")
          }
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
                value: (
                  <OutputValue value={value} openable={props.serviceOpenable} />
                ),
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
                value: <OutputValue value={value} openable={false} />,
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
                <span>{row.name}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

/** Public output value: http(s) → prominent link; otherwise monospace text. */
function OutputValue(props: {
  readonly value: unknown;
  readonly openable?: boolean;
}): JSX.Element {
  return (
    <Switch fallback={<code>{stringifyOutput(props.value)}</code>}>
      <Match when={isUrlString(props.value) && props.openable !== false}>
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
      <Match when={isUrlString(props.value)}>
        <span class="wa-output-url">
          <code>{props.value as string}</code>
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

function activityBelongsToCapsule(
  event: ActivityEvent,
  capsuleId: string,
): boolean {
  return (
    event.metadata.capsuleId === capsuleId ||
    event.metadata.installationId === capsuleId ||
    event.targetId === capsuleId
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

interface CapsuleProviderConnectionRow {
  readonly provider: string;
  readonly alias: string;
  readonly connectionId: string;
}

function providerConnectionToRow(
  binding: CapsuleProviderConnectionBinding,
): CapsuleProviderConnectionRow {
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
      connection.status === "verified" &&
      sameProviderFamily(provider, connection.providerSource),
  );
}

function providerConnectionLabel(
  providerConnection: ProviderConnection,
): string {
  return (
    providerConnection.displayName ||
    providerDisplayName(providerConnection.providerSource)
  );
}

function providerDisplayName(provider: string): string {
  const name = providerTail(provider).trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : provider;
}

function boundConnectionLabel(
  row: CapsuleProviderConnectionRow,
  providerConnections: readonly ProviderConnection[],
): string {
  const match = providerConnections.find(
    (connection) => connection.id === row.connectionId,
  );
  return match ? providerConnectionLabel(match) : t("common.none");
}

function boundProviderLabel(row: CapsuleProviderConnectionRow): string {
  if (!row.provider.trim()) return t("app.bindings.providerPlaceholder");
  return row.alias
    ? `${providerDisplayName(row.provider)} (${row.alias})`
    : providerDisplayName(row.provider);
}

function buildProviderConnections(
  rows: readonly CapsuleProviderConnectionRow[],
  options: {
    readonly providerConnections: readonly ProviderConnection[];
  },
):
  | { readonly connections: CapsuleProviderConnectionBindings }
  | { readonly error: string } {
  const connections: CapsuleProviderConnectionBinding[] = [];
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

type ConfigVariableType = "string" | "number" | "boolean" | "json";

interface ConfigVariableRow {
  id: string;
  originalName?: string;
  name: string;
  label: string;
  helper?: string;
  placeholder?: string;
  value: string;
  type: ConfigVariableType;
  required: boolean;
  secret: boolean;
  advanced: boolean;
  storeField: boolean;
  hasExistingValue: boolean;
  deleted?: boolean;
}

const SYSTEM_CONFIG_VARIABLES = new Set([
  "takosumi_accounts_url",
  "takosumi_accounts_issuer_url",
  "takosumi_accounts_client_id",
  "takosumi_accounts_redirect_uri",
]);

function configRowsFromInstallConfig(
  config: InstallConfig | undefined,
): readonly ConfigVariableRow[] {
  if (!config) return [];
  const variables = config.variableMapping ?? {};
  const rows: ConfigVariableRow[] = [];
  const seen = new Set<string>();
  for (const input of config.store?.inputs ?? []) {
    if (SYSTEM_CONFIG_VARIABLES.has(input.name)) continue;
    const type = input.type ?? "string";
    const value = variables[input.name] ?? input.defaultValue ?? "";
    rows.push({
      id: `store:${input.name}`,
      originalName: input.name,
      name: input.name,
      label: localizedText(input.label) ?? input.name,
      helper: localizedText(input.helper),
      placeholder: input.placeholder,
      value: input.secret ? "" : configValueToText(value, type),
      type,
      required: input.required === true,
      secret: input.secret === true || variableNameLooksSecret(input.name),
      advanced: input.advanced === true,
      storeField: true,
      hasExistingValue: Object.prototype.hasOwnProperty.call(
        variables,
        input.name,
      ),
    });
    seen.add(input.name);
  }
  for (const [name, value] of Object.entries(variables)) {
    if (SYSTEM_CONFIG_VARIABLES.has(name) || seen.has(name)) continue;
    const type = inferConfigVariableType(value);
    const secret = variableNameLooksSecret(name);
    rows.push({
      id: `custom:${name}`,
      originalName: name,
      name,
      label: name,
      value: secret ? "" : configValueToText(value, type),
      type,
      required: false,
      secret,
      advanced: true,
      storeField: false,
      hasExistingValue: true,
    });
  }
  return rows;
}

function primaryConfigVariableNames(
  config: InstallConfig | undefined,
): ReadonlySet<string> {
  const installExperience = config?.store?.installExperience;
  const publicEndpoint = installExperiencePublicEndpoint(installExperience);
  const initialSecret = installExperienceInitialSecret(installExperience);
  return new Set(
    [
      installExperienceServiceNameVariable(installExperience),
      publicEndpoint?.subdomainVariable,
      publicEndpoint?.urlVariable,
      initialSecret?.variable,
      "project_name",
    ].filter((name): name is string => Boolean(name)),
  );
}

function localizedText(
  text: { readonly ja: string; readonly en: string } | undefined,
): string | undefined {
  if (!text) return undefined;
  return locale() === "ja" ? text.ja : text.en;
}

function variableNameLooksSecret(name: string): boolean {
  return /(^|[_-])(password|passwd|token|secret|api[_-]?key|private[_-]?key)([_-]|$)/iu.test(
    name,
  );
}

function inferConfigVariableType(value: unknown): ConfigVariableType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (value !== null && typeof value === "object") return "json";
  return "string";
}

function configValueToText(value: unknown, type: ConfigVariableType): string {
  if (value === null || value === undefined) return "";
  if (type === "json") {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }
  if (type === "boolean")
    return value === true || value === "true" ? "true" : "false";
  return typeof value === "string" ? value : String(value);
}

function configSummaryItems(config: InstallConfig | undefined) {
  if (!config) return [];
  const variables = config.variableMapping ?? {};
  const endpoint = installExperiencePublicEndpoint(
    config.store?.installExperience,
  );
  const subdomainVariable = endpoint?.subdomainVariable;
  const urlVariable = endpoint?.urlVariable;
  const subdomain = subdomainVariable
    ? stringConfigValue(variables[subdomainVariable])
    : undefined;
  const publicUrl = urlVariable
    ? stringConfigValue(variables[urlVariable])
    : undefined;
  const oidcReady =
    stringConfigValue(variables.takosumi_accounts_issuer_url) &&
    stringConfigValue(variables.takosumi_accounts_client_id);
  return [
    ...(publicUrl
      ? [{ label: t("app.config.publicUrl"), value: <code>{publicUrl}</code> }]
      : []),
    ...(subdomain
      ? [{ label: t("app.config.subdomain"), value: <code>{subdomain}</code> }]
      : []),
    {
      label: t("app.config.oidc"),
      value: oidcReady ? t("app.config.oidcOn") : t("app.config.oidcOff"),
    },
    {
      label: t("app.config.updatedAt"),
      value: formatDateTime(config.updatedAt),
    },
  ];
}

function stringConfigValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function newCustomConfigRow(index: number): ConfigVariableRow {
  return {
    id: `new:${Date.now()}:${index}`,
    name: "",
    label: t("app.config.customName"),
    value: "",
    type: "string",
    required: false,
    secret: false,
    advanced: true,
    storeField: false,
    hasExistingValue: false,
  };
}

function configControlId(row: ConfigVariableRow, suffix: string): string {
  return `app-config-${suffix}-${row.id.replace(/[^a-z0-9_-]+/giu, "-")}`;
}

function buildConfigVariablePatch(rows: readonly ConfigVariableRow[]):
  | {
      readonly variableMapping: Readonly<Record<string, JsonValue>>;
      readonly removeVariables: readonly string[];
    }
  | { readonly error: string } {
  const variableMapping: Record<string, JsonValue> = {};
  const removeVariables = new Set<string>();
  const seen = new Set<string>();
  for (const row of rows) {
    const originalName = row.originalName?.trim();
    if (row.deleted) {
      if (originalName) removeVariables.add(originalName);
      continue;
    }
    const name = row.name.trim();
    if (!name) {
      if (!row.value.trim()) continue;
      return { error: t("app.config.errorNameRequired") };
    }
    if (/\s/u.test(name)) {
      return { error: t("app.config.errorNameInvalid", { name }) };
    }
    if (seen.has(name)) {
      return { error: t("app.config.errorNameDuplicate", { name }) };
    }
    seen.add(name);
    if (originalName && originalName !== name)
      removeVariables.add(originalName);
    if (row.secret && row.value.trim() === "") continue;
    const parsed = parseConfigVariableValue(row);
    if ("error" in parsed) return parsed;
    variableMapping[name] = parsed.value;
  }
  return { variableMapping, removeVariables: [...removeVariables] };
}

function parseConfigVariableValue(
  row: ConfigVariableRow,
): { readonly value: JsonValue } | { readonly error: string } {
  const raw = row.value.trim();
  if (row.type === "boolean") return { value: raw === "true" };
  if (row.type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      return { error: t("app.config.errorNumber", { name: row.name }) };
    }
    return { value };
  }
  if (row.type === "json") {
    if (!raw) return { value: null };
    try {
      return { value: JSON.parse(raw) as JsonValue };
    } catch {
      return { error: t("app.config.errorJson", { name: row.name }) };
    }
  }
  return { value: row.value };
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
  readonly installConfig: InstallConfig | undefined;
  readonly installConfigLoading: boolean;
  readonly providerConnections: CapsuleProviderConnectionBindings | undefined;
  readonly availableProviderConnections: readonly ProviderConnection[];
  readonly capsuleId: string;
  readonly dangerHref: string;
  readonly onSaved: () => void | Promise<void>;
}) {
  const [rows, setRows] = createSignal<CapsuleProviderConnectionRow[]>([]);
  const [variableRows, setVariableRows] = createSignal<ConfigVariableRow[]>([]);
  const [formError, setFormError] = createSignal<string | null>(null);
  const [configError, setConfigError] = createSignal<string | null>(null);

  createEffect(() => {
    const providerConnections = props.providerConnections;
    if (!providerConnections) return;
    setRows(providerConnections.map(providerConnectionToRow));
  });

  createEffect(() => {
    setVariableRows([...configRowsFromInstallConfig(props.installConfig)]);
  });

  const update = (
    index: number,
    patch: Partial<CapsuleProviderConnectionRow>,
  ) =>
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  const updateVariable = (id: string, patch: Partial<ConfigVariableRow>) =>
    setVariableRows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  const removeVariable = (id: string) => updateVariable(id, { deleted: true });

  const primaryNames = createMemo(() =>
    primaryConfigVariableNames(props.installConfig),
  );
  const visibleVariableRows = createMemo(() =>
    variableRows().filter((row) => !row.deleted),
  );
  const primaryVariableRows = createMemo(() =>
    visibleVariableRows().filter(
      (row) => !row.advanced || primaryNames().has(row.name),
    ),
  );
  const advancedVariableRows = createMemo(() =>
    visibleVariableRows().filter(
      (row) => row.advanced && !primaryNames().has(row.name),
    ),
  );
  const configSummary = createMemo(() =>
    configSummaryItems(props.installConfig),
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
    await putCapsuleProviderConnectionSet(
      props.capsuleId,
      providerConnections.connections,
    );
    await props.onSaved();
  });
  const saveVariables = createAction(async () => {
    setConfigError(null);
    if (!props.installConfig) {
      setConfigError(t("app.config.notReady"));
      return;
    }
    const patch = buildConfigVariablePatch(variableRows());
    if ("error" in patch) {
      setConfigError(patch.error);
      return;
    }
    await patchInstallConfig(props.installConfig.id, patch);
    await props.onSaved();
  });

  return (
    <>
      <details class="wb-disclosure" open>
        <summary>{t("app.config.title")}</summary>
        <Card>
          <CardHeader
            title={t("app.config.title")}
            subtitle={t("app.config.subtitle")}
          />
          <Switch>
            <Match when={props.installConfigLoading}>
              <p class="muted">{t("common.loading")}</p>
            </Match>
            <Match when={!props.installConfig}>
              <p class="muted">{t("app.config.notReady")}</p>
            </Match>
            <Match when={props.installConfig}>
              <Show when={configSummary().length > 0}>
                <KVList items={configSummary()} />
              </Show>
              <form
                class="wb-input-vars"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveVariables.run();
                }}
              >
                <Show
                  when={primaryVariableRows().length > 0}
                  fallback={<p class="muted">{t("app.config.empty")}</p>}
                >
                  <VariableRows
                    rows={primaryVariableRows()}
                    onChange={updateVariable}
                    onRemove={removeVariable}
                  />
                </Show>
                <details class="wb-disclosure">
                  <summary>{t("app.config.advanced")}</summary>
                  <VariableRows
                    rows={advancedVariableRows()}
                    onChange={updateVariable}
                    onRemove={removeVariable}
                  />
                  <div class="wa-form-actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() =>
                        setVariableRows((prev) => [
                          ...prev,
                          newCustomConfigRow(prev.length),
                        ])
                      }
                    >
                      {t("app.config.addVariable")}
                    </Button>
                  </div>
                </details>
                <div class="wa-form-actions">
                  <Button
                    variant="primary"
                    type="submit"
                    disabled={saveVariables.busy()}
                    busy={saveVariables.busy()}
                  >
                    {saveVariables.busy()
                      ? t("common.saving")
                      : t("common.save")}
                  </Button>
                </div>
                <Show when={configError()}>
                  {(m) => (
                    <p class="wa-error" role="alert">
                      {m()}
                    </p>
                  )}
                </Show>
                <Show when={saveVariables.error()}>
                  {(m) => (
                    <p class="wa-error" role="alert">
                      {m()}
                    </p>
                  )}
                </Show>
              </form>
            </Match>
          </Switch>
        </Card>
      </details>

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
                {/* <Index>: `update` replaces the row object per keystroke,
                    so reference-keyed <For> would recreate the focused input
                    on every character. */}
                <Index each={rows()}>
                  {(row, index) => {
                    const readyConnections = () =>
                      readyProviderConnectionsForProvider(
                        row().provider,
                        props.availableProviderConnections,
                      );
                    return (
                      <div class="wa-binding-row">
                        <div class="wa-binding-head">
                          <strong>{boundProviderLabel(row())}</strong>
                        </div>
                        <div class="wa-binding-controls">
                          <Select
                            value={row().connectionId}
                            onChange={(e) =>
                              update(index, {
                                connectionId: e.currentTarget.value,
                              })
                            }
                          >
                            <option
                              value=""
                              selected={row().connectionId === ""}
                            >
                              {t("app.bindings.selectConnection")}
                            </option>
                            <For each={readyConnections()}>
                              {(connection) => (
                                <option
                                  value={connection.id}
                                  selected={
                                    connection.id === row().connectionId
                                  }
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
                                prev.filter((_, i) => i !== index),
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
                              value={row().provider}
                              onInput={(e) =>
                                update(index, {
                                  provider: e.currentTarget.value,
                                  connectionId: "",
                                })
                              }
                              placeholder={t(
                                "app.bindings.providerPlaceholder",
                              )}
                            />
                            <Input
                              value={row().alias}
                              onInput={(e) =>
                                update(index, {
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
                </Index>
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

      <Card>
        <CardHeader
          title={t("app.settings.removeTitle")}
          subtitle={t("app.settings.removeBody")}
          actions={
            <Button variant="danger" href={props.dangerHref}>
              {t("app.settings.removeCta")}
            </Button>
          }
        />
      </Card>
    </>
  );
}

function VariableRows(props: {
  readonly rows: readonly ConfigVariableRow[];
  readonly onChange: (id: string, patch: Partial<ConfigVariableRow>) => void;
  readonly onRemove: (id: string) => void;
}) {
  // <Index>: onChange replaces the edited row object per keystroke, so a
  // reference-keyed <For> would dispose and recreate the focused input on
  // every character (rows keep a stable position; identity is row().id).
  return (
    <div class="wb-variable-list">
      <Index each={props.rows}>
        {(row) => (
          <div class="wb-variable-row">
            <FormField
              label={row().storeField ? row().label : t("app.config.name")}
            >
              <Input
                id={configControlId(row(), "name")}
                name={`configName:${row().id}`}
                value={row().name}
                disabled={row().storeField}
                placeholder={t("app.config.customName")}
                onInput={(e) =>
                  props.onChange(row().id, { name: e.currentTarget.value })
                }
              />
            </FormField>
            <FormField
              label={row().storeField ? t("app.config.value") : row().label}
              hint={
                row().secret &&
                row().hasExistingValue &&
                row().value.trim() === ""
                  ? t("app.config.secretHint")
                  : row().helper
              }
              required={row().required}
            >
              <ConfigVariableInput row={row()} onChange={props.onChange} />
            </FormField>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => props.onRemove(row().id)}
            >
              {row().storeField
                ? t("app.config.reset")
                : t("app.config.remove")}
            </Button>
          </div>
        )}
      </Index>
    </div>
  );
}

function ConfigVariableInput(props: {
  readonly row: ConfigVariableRow;
  readonly onChange: (id: string, patch: Partial<ConfigVariableRow>) => void;
}) {
  const setValue = (value: string) => props.onChange(props.row.id, { value });
  const id = () => configControlId(props.row, "value");
  const name = () => `configValue:${props.row.name || props.row.id}`;
  return (
    <Switch>
      <Match when={props.row.type === "boolean"}>
        <Checkbox
          id={id()}
          name={name()}
          checked={props.row.value === "true"}
          onChange={(e) => setValue(e.currentTarget.checked ? "true" : "false")}
          label={t("app.config.enabled")}
        />
      </Match>
      <Match when={props.row.type === "json"}>
        <Textarea
          id={id()}
          name={name()}
          rows={4}
          value={props.row.value}
          placeholder={props.row.placeholder}
          onInput={(e) => setValue(e.currentTarget.value)}
        />
      </Match>
      <Match when={props.row.type === "number"}>
        <Input
          id={id()}
          name={name()}
          type="number"
          value={props.row.value}
          placeholder={props.row.placeholder}
          onInput={(e) => setValue(e.currentTarget.value)}
        />
      </Match>
      <Match when={props.row.type === "string"}>
        <Input
          id={id()}
          name={name()}
          type={props.row.secret ? "password" : "text"}
          value={props.row.value}
          placeholder={props.row.placeholder}
          onInput={(e) => setValue(e.currentTarget.value)}
        />
      </Match>
    </Switch>
  );
}
