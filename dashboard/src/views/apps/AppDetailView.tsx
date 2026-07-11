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
  on,
  Show,
  Switch,
} from "solid-js";
import { A, useBeforeLeave, useNavigate, useParams } from "@solidjs/router";
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
  ControlApiError,
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
  planCapsuleUpdate,
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
  buildConfigVariablePatch,
  capsuleDisplayName,
  type ConfigVariableRow,
  configRowsFromInstallConfig,
  effectiveCapsuleStatus,
  isDeploymentOpenable,
  isUrlString,
  launchUrlFromDeployment,
  publicLinkRowLabels,
  releaseActivationStatusForDeployment,
  outputLabel,
} from "../../lib/capsules-ui.ts";
import {
  formatDateTime,
  locale,
  setDocumentTitle,
  t,
} from "../../i18n/index.ts";
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
import { clearCapsuleListCache } from "../../lib/capsule-list.ts";
import { clearCurrentStateVersionCache } from "../../lib/current-state-versions.ts";
import { clearDashboardOverviewCache } from "../../lib/dashboard-overview.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";

type TabId = "overview" | "deploys" | "settings" | "danger";

export default function AppDetailView() {
  return <Page title={t("app.capsuleSub")}>{() => <Inner />}</Page>;
}

/** True only when the capsule fetch failed because it genuinely does not exist
 * — anything else (network, 5xx, auth hiccup) is transient and must offer a
 * retry, not the "not found" empty state (mirrors RunView.isRunNotFound). */
function isCapsuleNotFound(error: unknown): boolean {
  return (
    error instanceof ControlApiError &&
    (error.status === 404 || error.code === "not_found")
  );
}

function Inner() {
  const params = useParams();
  const navigate = useNavigate();
  const capsuleId = () => params.id ?? "";

  const [capsule, { refetch: refetchCapsule }] = createResource(
    capsuleId,
    getCapsule,
  );
  // Last-good capsule value that NEVER throws. Reading an errored resource
  // (`capsuleData()`) throws, so a transient refetch failure — e.g. the GET that a
  // config save or auto-update toggle triggers — would otherwise tear the whole
  // view (and any unsaved settings edits) down. Every render-path read uses
  // this; the Switch below shows the error EmptyState only on a FIRST-load
  // failure (`!capsule.latest`) and otherwise keeps the last-good content with
  // an inline refetch-failed notice.
  const capsuleData = () => capsule.latest;
  const tab = (): TabId => {
    const raw = params.tab;
    const resolved =
      raw === "deploys" || raw === "settings" || raw === "danger"
        ? raw
        : "overview";
    // A destroyed service has no delete action — the 削除 tab is hidden from
    // the strip, so a direct /danger URL falls back to overview instead of
    // rendering a dead 削除の確認 CTA. `.latest` never throws (unlike a read of
    // an errored resource).
    if (resolved === "danger" && capsule.latest?.status === "destroyed") {
      return "overview";
    }
    return resolved;
  };
  const workspaceId = () => capsuleData()?.workspaceId;
  const settingsCapsuleId = () => (tab() === "settings" ? capsuleId() : null);
  const settingsWorkspaceId = () =>
    tab() === "settings" ? (workspaceId() ?? null) : null;
  const deploysCapsuleId = () => (tab() === "deploys" ? capsuleId() : null);
  const graphWorkspaceId = () =>
    tab() === "overview" ? (workspaceId() ?? null) : null;
  const currentStateVersionId = () =>
    capsuleData()?.currentStateVersionId ?? capsuleData()?.currentDeploymentId ?? null;
  const [profile, { refetch: refetchProfile }] = createResource(
    settingsCapsuleId,
    getCapsuleProviderConnectionSet,
  );
  // Fetched on every tab (not just settings): the header shows the store
  // display name, which lives on the install config's store metadata.
  const installConfigId = () => capsuleData()?.installConfigId ?? null;
  const [installConfig, { refetch: refetchInstallConfig }] = createResource(
    installConfigId,
    getInstallConfig,
  );
  // Same source as the launcher tile name (store metadata) so the home screen
  // and the detail header agree on what the app is called. A failed install
  // config read must not break the header — fall back to the instance name.
  const displayName = createMemo(() => {
    if (installConfig.error) return undefined;
    return capsuleDisplayName(installConfig(), locale());
  });
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
  // Secondary-resource reads are guarded with `.error` first: reading an
  // errored resource THROWS, and a transient failure of any of these
  // supplemental fetches (activity / sources / graph / deployments / current
  // state version) must degrade to its own inline/empty state — never
  // white-screen the whole detail view. The primary `capsule` resource keeps
  // the load/notFound handling in the outer Switch.
  const activityEvents = createMemo(() =>
    activity.error ? [] : (activity() ?? []),
  );
  const sourceList = () => (sources.error ? [] : (sources() ?? []));
  const graphData = () => (graph.error ? undefined : graph());
  const deploymentList = () =>
    deployments.error ? [] : (deployments() ?? []);
  const currentStateVersionValue = () =>
    currentStateVersion.error ? undefined : currentStateVersion();
  // Guarded settings-tab inputs: a failed secondary fetch degrades the
  // field (config not-ready / no bindings) instead of crashing the tab.
  const settingsInstallConfig = () =>
    installConfig.error ? undefined : installConfig();
  const settingsProfileBindings = () =>
    profile.error ? undefined : profile()?.bindings;
  const settingsProviderConnections = () =>
    providerConnections.error ? [] : (providerConnections() ?? []);

  const source = createMemo(() =>
    sourceList().find((item) => item.id === capsuleData()?.sourceId),
  );
  const producers = createMemo(() =>
    dependencyRows(capsuleData(), graphData(), "producer"),
  );
  const consumers = createMemo(() =>
    dependencyRows(capsuleData(), graphData(), "consumer"),
  );

  createEffect(() => {
    const inst = capsuleData();
    if (inst) {
      setDocumentTitle(displayName() ?? inst.name);
      return;
    }
    if (capsule.error) {
      setDocumentTitle(t("app.notFound"));
    }
  });

  const deploymentHistory = createMemo(() =>
    [...deploymentList()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    ),
  );
  const currentDeployment = createMemo(() => {
    const current = currentStateVersionValue();
    if (current) return current;
    const list = deploymentHistory();
    const currentId =
      capsuleData()?.currentStateVersionId ?? capsuleData()?.currentDeploymentId;
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
      activityEvents(),
      capsuleId(),
    ),
  );
  const serviceOpenable = createMemo(
    () =>
      capsuleData()?.status !== "destroyed" &&
      isDeploymentOpenable(currentDeployment(), activityEvents(), capsuleId()),
  );
  const launchUrl = createMemo(() =>
    launchUrlFromDeployment(currentDeployment(), activityEvents(), capsuleId()),
  );

  /** Recent run/release events for THIS app (activity carries metadata.capsuleId). */
  const recentActivity = createMemo(() =>
    activityEvents()
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
    const envelope = await planCapsuleUpdate(capsuleId());
    const runId = extractRunId(envelope);
    if (runId) navigate(`/runs/${runId}`);
  });
  // 1-tap update: same plan run, but the run screen shows the App-Store-style
  // progress and auto-continues a clean plan to apply (?auto=update).
  const update = createAction(async () => {
    const envelope = await planCapsuleUpdate(capsuleId());
    const runId = extractRunId(envelope);
    if (runId) navigate(`/runs/${runId}?auto=update`);
  });
  const autoUpdateToggle = createAction(async () => {
    await setCapsuleAutoUpdate(capsuleId(), capsuleData()?.autoUpdate !== true);
    await refetchCapsule();
  });
  // Per-app showback: rendered only when usage was actually recorded, so
  // self-host with billing disabled never shows an empty money card.
  const [usageSummary] = createResource(capsuleId, (id) =>
    getCapsuleUsageSummary(id).catch(() => undefined),
  );
  const destroyPlan = createAction(async () => {
    const workspace = capsuleData()?.workspaceId;
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

  const serviceLabel = () => displayName() ?? capsuleData()?.name ?? "";

  const tabItems = () => {
    const base = `/services/${encodeURIComponent(capsuleId())}`;
    const items = [
      { href: base, label: t("app.tab.overview"), end: true },
      { href: `${base}/deploys`, label: t("app.tab.deploys") },
      { href: `${base}/settings`, label: t("app.tab.settings") },
    ];
    if (capsuleData()?.status !== "destroyed") {
      items.push({ href: `${base}/danger`, label: t("app.tab.danger") });
    }
    return items;
  };

  return (
    <>
      <Switch>
        {/* First load ONLY — every auto-update toggle and every config/profile
            save refetches the capsule, and `resource.loading` is true during
            those refetches too. Remounting the whole view for a skeleton on
            each would evict focus and re-seed the settings editors, silently
            discarding the sibling form's unsaved edits. Keep rendering
            `.latest` during refetches (mirrors RunView). */}
        <Match when={capsule.loading && !capsule.latest}>
          <Card>
            <Skeleton variant="block" />
          </Card>
        </Match>
        <Match when={capsule.error && !capsule.latest}>
          {/* FIRST-load failure only. A failed REFETCH of an already-loaded
              capsule keeps the last-good content (below) + an inline notice so
              unsaved settings edits are never torn down. Split a genuine 404
              (the service is gone) from a transient network / 5xx failure,
              which must offer a retry rather than masquerading as "見つかりません". */}
          <Show
            when={isCapsuleNotFound(capsule.error)}
            fallback={
              <EmptyState
                title={t("app.loadFailedTitle")}
                message={friendlyError(capsule.error, t).message}
                action={
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={() => void refetchCapsule()}
                  >
                    {t("common.retry")}
                  </Button>
                }
              />
            }
          >
            <EmptyState
              title={t("app.notFound")}
              message={t("app.notFoundMessage")}
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
          </Show>
        </Match>
        <Match when={capsuleData()}>
          {(inst) => (
            <>
              {/* A background refetch failed but we still have last-good data:
                  keep the screen (and unsaved edits) and just say so. */}
              <Show when={capsule.error}>
                <Toast tone="error">{t("app.refreshFailed")}</Toast>
              </Show>
              <PageHeader
                eyebrow={t("app.capsuleSub")}
                title={
                  <span class="wa-title-row">
                    {displayName() ?? inst().name}
                    {/* Store display name leads (matching the launcher tile);
                        the instance name stays visible as a muted secondary
                        only when the two differ. */}
                    <Show when={displayName() && displayName() !== inst().name}>
                      <span class="av-title-instance">{inst().name}</span>
                    </Show>
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
                    {/* One delete flow: the header button routes to the 削除
                        tab (plan-first) instead of opening a duplicate modal. */}
                    <Show
                      when={inst().status !== "destroyed" && tab() !== "danger"}
                    >
                      <Button
                        variant="danger"
                        href={`/services/${encodeURIComponent(capsuleId())}/danger`}
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

              {/* A service that never successfully applied (no StateVersion)
                  is stuck mid-setup — say so and offer the two ways out. */}
              <Show
                when={inst().status !== "destroyed" && !currentStateVersionId()}
              >
                <div class="av-setup-incomplete" role="status">
                  <p class="av-setup-incomplete-text">
                    {t("app.setupIncomplete.body")}
                  </p>
                  <div class="av-actions">
                    {/* Hide the 更新タブへ button when already on the 更新
                        (deploys) tab — otherwise it is a self-link that goes
                        nowhere. */}
                    <Show when={tab() !== "deploys"}>
                      <Button
                        variant="secondary"
                        size="sm"
                        href={`/services/${encodeURIComponent(capsuleId())}/deploys`}
                      >
                        {t("app.setupIncomplete.review")}
                      </Button>
                    </Show>
                    <Button
                      variant="danger"
                      size="sm"
                      href={`/services/${encodeURIComponent(capsuleId())}/danger`}
                    >
                      {t("app.setupIncomplete.delete")}
                    </Button>
                  </div>
                </div>
              </Show>

              <Tabs items={tabItems()} aria-label={t("app.capsuleSub")} />

              <div class="wa-stack">
                <Switch>
                  <Match when={tab() === "overview"}>
                    <OverviewTab
                      publicLinkOutputs={publicLinkOutputs()}
                      otherPublicOutputs={otherPublicOutputs()}
                      hasDeployment={currentDeployment() !== undefined}
                      destroyed={inst().status === "destroyed"}
                      serviceOpenable={serviceOpenable()}
                      releaseActivationStatus={releaseActivationStatus()}
                      outputsLoading={currentStateVersion.loading}
                      outputsError={Boolean(currentStateVersion.error)}
                      producers={producers()}
                      consumers={consumers()}
                    />
                    <Show when={(usageSummary()?.eventCount ?? 0) > 0}>
                      <Card>
                        <CardHeader
                          title={t("app.usage.title")}
                          subtitle={t("app.usage.body")}
                          actions={
                            <UsageAmount micros={usageSummary()!.usdMicros} />
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
                      installConfig={settingsInstallConfig()}
                      installConfigLoading={installConfig.loading}
                      sourceLoading={sources.loading}
                      providerConnections={settingsProfileBindings()}
                      availableProviderConnections={settingsProviderConnections()}
                      capsuleId={capsuleId()}
                      deploysHref={`/services/${encodeURIComponent(capsuleId())}/deploys`}
                      onSaved={(scope) =>
                        // Refetch ONLY the saved form's resource (+capsule for
                        // display). Refetching the sibling's resource would flip
                        // its reference and re-seed its editor, discarding the
                        // user's unsaved edits there.
                        void Promise.all([
                          scope === "profile"
                            ? refetchProfile()
                            : Promise.resolve(),
                          scope === "config"
                            ? refetchInstallConfig()
                            : Promise.resolve(),
                          refetchCapsule(),
                        ])
                      }
                    />
                  </Match>
                  <Match when={tab() === "danger"}>
                    <Card>
                      <CardHeader
                        title={t("app.danger.destroyTitle")}
                        subtitle={t("app.danger.destroyBody", {
                          name: serviceLabel(),
                        })}
                      />
                      <div class="wa-form-actions">
                        <Button
                          variant="danger"
                          type="button"
                          disabled={destroyPlan.busy()}
                          busy={destroyPlan.busy()}
                          onClick={() => void destroyPlan.run()}
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

/**
 * Per-app showback amount. Raw micro amounts below one cent ($0.000823)
 * read like display bugs — collapse them to a "< $0.01" note and keep the
 * exact value reachable via the title attribute.
 */
function UsageAmount(props: { readonly micros: number }): JSX.Element {
  const ONE_CENT_MICROS = 10_000;
  const subCent = () => props.micros > 0 && props.micros < ONE_CENT_MICROS;
  return (
    <span
      class="wa-usage-amount"
      title={subCent() ? formatUsdMicros(props.micros) : undefined}
    >
      {subCent() ? t("app.usage.subCent") : formatUsdMicros(props.micros)}
      {/* The exact sub-cent amount is otherwise title-only (unreachable to
          screen readers) — expose it as off-screen text. */}
      <Show when={subCent()}>
        <span class="sr-only"> ({formatUsdMicros(props.micros)})</span>
      </Show>
    </span>
  );
}

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
  readonly destroyed: boolean;
  readonly serviceOpenable: boolean;
  readonly releaseActivationStatus:
    "not_required" | "pending" | "succeeded" | "failed";
  readonly outputsLoading: boolean;
  readonly outputsError: boolean;
  readonly producers: readonly DependencyRow[];
  readonly consumers: readonly DependencyRow[];
}) {
  // Distinguishing labels: several well-known link keys share one friendly
  // label, which rendered near-identical 公開アドレス rows on live services.
  const linkLabels = createMemo(() =>
    publicLinkRowLabels(props.publicLinkOutputs),
  );
  return (
    <>
      <Card>
        {/* Mutually exclusive copy, driven by the actual service state:
            destroyed → records-only; never deployed → the generic subtitle
            (the body says links appear after a deploy); otherwise the normal
            activation-aware subtitle. A preparing service must never read as
            deleted. */}
        <CardHeader
          title={t("app.outputs.title")}
          subtitle={
            props.destroyed
              ? t("app.outputs.deletedSubtitle")
              : props.releaseActivationStatus === "pending"
                ? t("app.outputs.activationPending")
                : props.releaseActivationStatus === "failed"
                  ? t("app.outputs.activationFailed")
                  : t("app.outputs.subtitle")
          }
        />
        <Switch>
          <Match when={props.outputsLoading}>
            {/* Shape-matched placeholder (the links render as a KVList) rather
                than a bare "読み込み中…" line that reflows on load. */}
            <Skeleton variant="row" count={2} />
          </Match>
          <Match when={props.outputsError}>
            <p class="wa-error" role="alert">
              {t("app.outputs.loadError")}
            </p>
          </Match>
          <Match when={props.publicLinkOutputs.length === 0}>
            <p class="muted">
              {props.hasDeployment || props.destroyed
                ? t("app.outputs.none")
                : t("app.outputs.empty")}
            </p>
          </Match>
          <Match when={props.publicLinkOutputs.length > 0}>
            <KVList
              items={props.publicLinkOutputs.map(([name, value], index) => ({
                label: linkLabels()[index] ?? outputLabel(name),
                value: (
                  <OutputValue
                    value={value}
                    openable={props.serviceOpenable}
                    // Only the first/primary link keeps the filled style; a
                    // column of identical filled buttons reads as noise.
                    primary={index === 0}
                  />
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
      {/* h2, not h4: the page h1 is the only heading above this one. */}
      <h2>{props.title}</h2>
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
  /** Only the first/primary link row keeps the filled button style. */
  readonly primary?: boolean;
}): JSX.Element {
  return (
    <Switch fallback={<code>{stringifyOutput(props.value)}</code>}>
      <Match when={isUrlString(props.value) && props.openable !== false}>
        <span class="wa-output-url">
          <Button
            variant={props.primary ? "primary" : "secondary"}
            size="sm"
            href={props.value as string}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t("app.output.openPublicLink")}
          </Button>
          {/* Inline muted URL: the old ▶アドレス disclosure repeated the row
              label and hid the one value the card exists to show. */}
          <code class="av-output-url-text">{props.value as string}</code>
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
              {/* Shape-matched rows rather than a bare "読み込み中…" line. */}
              <Skeleton variant="row" count={3} />
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
                            {/* Self-descriptive disclosure label: the bare
                                "その他" hid the restore action entirely. */}
                            <summary>
                              {t("app.deploys.restoreDisclosure")}
                            </summary>
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

// Config-row seeding + the dirty-only save patch live in
// lib/capsules-ui.ts (configRowsFromInstallConfig / buildConfigVariablePatch)
// so the write semantics are unit-testable. SYSTEM_CONFIG_VARIABLES
// (takosumi_accounts_issuer_url and friends) are filtered there too.

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
    // 自動ログイン comes from the store listing's oidc_client projection, not
    // from anything the user can set on this screen — so an unset value is
    // omitted rather than rendered as a dead 未設定 row.
    ...(oidcReady
      ? [{ label: t("app.config.oidc"), value: t("app.config.oidcOn") }]
      : []),
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
    defaultText: "",
    savedValue: "",
    dirty: false,
    resetToDefault: false,
  };
}

function configControlId(row: ConfigVariableRow, suffix: string): string {
  return `app-config-${suffix}-${row.id.replace(/[^a-z0-9_-]+/giu, "-")}`;
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
  readonly sourceLoading: boolean;
  readonly providerConnections: CapsuleProviderConnectionBindings | undefined;
  readonly availableProviderConnections: readonly ProviderConnection[];
  readonly capsuleId: string;
  readonly deploysHref: string;
  readonly onSaved: (scope: "profile" | "config") => void | Promise<void>;
}) {
  const [rows, setRows] = createSignal<CapsuleProviderConnectionRow[]>([]);
  const [variableRows, setVariableRows] = createSignal<ConfigVariableRow[]>([]);
  const [formError, setFormError] = createSignal<string | null>(null);
  const [configError, setConfigError] = createSignal<string | null>(null);
  // One saved-note signal PER form: a shared signal meant saving one form hid
  // the other's still-true pending-deploy note, and a later FAILED save left
  // the stale success note above the new error.
  const [configSavedNote, setConfigSavedNote] = createSignal(false);
  const [profileSavedNote, setProfileSavedNote] = createSignal(false);
  // Provider-binding rows have no per-row dirty flag (unlike config rows), so
  // track binding edits explicitly for the navigation-away guard below.
  const [profileDirty, setProfileDirty] = createSignal(false);
  const { confirm } = useConfirmDialog();

  createEffect(() => {
    const providerConnections = props.providerConnections;
    if (!providerConnections) return;
    setRows(providerConnections.map(providerConnectionToRow));
    // Reseeding from a fresh fetch (initial load or post-save refetch) is the
    // clean baseline — clear the dirty flag.
    setProfileDirty(false);
  });

  // The settings tab holds unsaved edits in plain signals; navigating away
  // (tab strip, header link, back) would silently discard them. Warn first,
  // and only proceed if the user confirms (mirrors the destructive-confirm
  // grammar used elsewhere).
  const isDirty = () =>
    profileDirty() ||
    variableRows().some(
      (row) => row.dirty || row.deleted === true || row.resetToDefault,
    );
  useBeforeLeave((event) => {
    if (event.defaultPrevented || !isDirty()) return;
    event.preventDefault();
    void (async () => {
      const proceed = await confirm({
        title: t("app.settings.leaveConfirm.title"),
        message: t("app.settings.leaveConfirm.body"),
        confirmText: t("app.settings.leaveConfirm.confirm"),
        cancelText: t("common.cancel"),
      });
      if (proceed) event.retry(true);
    })();
  });

  // Seed ONLY from the install config. configRowsFromInstallConfig localizes
  // labels (takes locale()), so a plain effect would also track locale and, on
  // a language switch, re-seed the rows — silently discarding the user's
  // unsaved edits. `on` pins the dependency to installConfig alone.
  createEffect(
    on(
      () => props.installConfig,
      (installConfig) => {
        setVariableRows([
          ...configRowsFromInstallConfig(installConfig, locale()),
        ]);
      },
    ),
  );

  const update = (
    index: number,
    patch: Partial<CapsuleProviderConnectionRow>,
  ) => {
    setProfileDirty(true);
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  };
  // User edits mark the row dirty — buildConfigVariablePatch writes ONLY dirty
  // rows, so a no-edit save can never pin listing defaults / "" / false / null
  // over the module's own HCL defaults. Editing also cancels a pending リセット.
  const editVariable = (id: string, patch: Partial<ConfigVariableRow>) =>
    setVariableRows((prev) =>
      prev.map((row) =>
        row.id === id
          ? { ...row, ...patch, dirty: true, resetToDefault: false }
          : row,
      ),
    );
  // Store rows: リセット presents the default (visible, marked 既定値) and —
  // when the value pre-existed in the mapping — marks remove-on-save, which
  // stays undoable (元に戻す) until saved. Free-form rows are simply removed.
  const removeVariable = (id: string) =>
    setVariableRows((prev) =>
      prev.map((row) => {
        if (row.id !== id) return row;
        if (!row.storeField) return { ...row, deleted: true };
        if (row.resetToDefault) {
          return {
            ...row,
            resetToDefault: false,
            dirty: false,
            value: row.savedValue,
          };
        }
        return {
          ...row,
          value: row.defaultText,
          dirty: false,
          resetToDefault: row.hasExistingValue,
        };
      }),
    );

  const primaryNames = createMemo(() =>
    primaryConfigVariableNames(props.installConfig),
  );
  const visibleVariableRows = createMemo(() =>
    variableRows().filter((row) => !row.deleted),
  );
  // Primary rows are ONLY listing-declared inputs (labelled, key read-only);
  // free-form key+value rows always stay under the その他の設定値 disclosure.
  const isPrimaryVariableRow = (row: ConfigVariableRow) =>
    row.storeField && (!row.advanced || primaryNames().has(row.name));
  const primaryVariableRows = createMemo(() =>
    visibleVariableRows().filter(isPrimaryVariableRow),
  );
  const advancedVariableRows = createMemo(() =>
    visibleVariableRows().filter((row) => !isPrimaryVariableRow(row)),
  );
  const configSummary = createMemo(() =>
    configSummaryItems(props.installConfig),
  );

  const saveProfile = createAction(async () => {
    setFormError(null);
    // Clear at the start so a save that FAILS never leaves the previous
    // attempt's success note above the fresh error.
    setProfileSavedNote(false);
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
    await props.onSaved("profile");
    setProfileSavedNote(true);
  });
  const saveVariables = createAction(async () => {
    setConfigError(null);
    setConfigSavedNote(false);
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
    await props.onSaved("config");
    setConfigSavedNote(true);
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
                    onChange={editVariable}
                    onRemove={removeVariable}
                  />
                </Show>
                <details class="wb-disclosure">
                  <summary>{t("app.config.advanced")}</summary>
                  <VariableRows
                    rows={advancedVariableRows()}
                    onChange={editVariable}
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
                <Show when={configSavedNote()}>
                  <div class="wa-saved-note" role="status">
                    <span>{t("app.config.savedNeedsDeploy")}</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      href={props.deploysHref}
                    >
                      {t("app.config.deployChanges")}
                    </Button>
                  </div>
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
                            aria-label={`${boundProviderLabel(row())} ${t(
                              "app.bindings.selectConnection",
                            )}`}
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
                            onClick={() => {
                              setProfileDirty(true);
                              setRows((prev) =>
                                prev.filter((_, i) => i !== index),
                              );
                            }}
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
                              aria-label={t("app.bindings.providerLabel")}
                            />
                            <Input
                              value={row().alias}
                              onInput={(e) =>
                                update(index, {
                                  alias: e.currentTarget.value,
                                })
                              }
                              placeholder={t("app.bindings.aliasPlaceholder")}
                              aria-label={t("app.bindings.aliasLabel")}
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
                  onClick={() => {
                    setProfileDirty(true);
                    setRows((prev) => [
                      ...prev,
                      {
                        provider: "",
                        alias: "",
                        connectionId: "",
                      },
                    ]);
                  }}
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
              {/* Provider-binding changes, like config edits, only take effect
                  on the next deploy — confirm the save and offer the deploy
                  link. Separate per-form signal: saving the config form must
                  not hide this note (and vice versa). */}
              <Show when={profileSavedNote()}>
                <div class="wa-saved-note" role="status">
                  <span>{t("app.config.savedNeedsDeploy")}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    href={props.deploysHref}
                  >
                    {t("app.config.deployChanges")}
                  </Button>
                </div>
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
              fallback={
                <p class="muted">
                  {props.sourceLoading
                    ? t("app.source.loading")
                    : t("app.source.unavailable")}
                </p>
              }
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
      {/* No bottom delete section here: deletion lives on the 削除 tab (one
          plan-first flow), which the tab strip and header button already
          point at. */}
    </>
  );
}

/** True when a store row currently presents the module default (nothing will
 * be written for it on save). */
function rowPresentsDefault(row: ConfigVariableRow): boolean {
  return (
    row.storeField &&
    !row.dirty &&
    (row.resetToDefault || !row.hasExistingValue)
  );
}

function variableRowHint(row: ConfigVariableRow): string | undefined {
  if (row.resetToDefault) return t("app.config.resetPendingHint");
  if (row.secret && row.hasExistingValue && row.value.trim() === "") {
    return t("app.config.secretHint");
  }
  if (rowPresentsDefault(row)) {
    // Mark default-presenting rows as 既定値 so an untouched field is legibly
    // "the module's default", not an explicit value pinned by this screen.
    return row.helper
      ? `${row.helper} — ${t("app.config.defaultBadge")}`
      : t("app.config.defaultBadge");
  }
  return row.helper;
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
            {/* A listing-declared variable's KEY is fixed by the store input —
                show it as muted mono text, not an editable textbox. Only
                free-form variables keep an editable name field. */}
            <Show
              when={!row().storeField}
              fallback={
                <div class="tg-field">
                  <span class="tg-field-label">{t("app.config.name")}</span>
                  <code class="av-config-key">{row().name}</code>
                </div>
              }
            >
              <FormField label={t("app.config.name")}>
                <Input
                  id={configControlId(row(), "name")}
                  name={`configName:${row().id}`}
                  value={row().name}
                  placeholder={t("app.config.customName")}
                  onInput={(e) =>
                    props.onChange(row().id, { name: e.currentTarget.value })
                  }
                />
              </FormField>
            </Show>
            <FormField
              // A store input carries a localized human label — use it as the
              // value field's label so the editor reads プロジェクト名, not
              // the raw project_name key.
              label={row().storeField ? row().label : t("app.config.value")}
              hint={variableRowHint(row())}
              required={row().required}
              // A boolean row renders a self-labeling Checkbox (its own
              // <label>); wrap it in a group, not another <label>.
              as={row().type === "boolean" ? "group" : "label"}
            >
              <ConfigVariableInput row={row()} onChange={props.onChange} />
            </FormField>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              aria-label={
                row().storeField
                  ? row().resetToDefault
                    ? t("app.config.undoResetAria", { name: row().name })
                    : t("app.config.resetAria", { name: row().name })
                  : t("app.config.removeAria", {
                      name: row().name || t("app.config.customName"),
                    })
              }
              onClick={() => props.onRemove(row().id)}
            >
              {row().storeField
                ? row().resetToDefault
                  ? t("app.config.undoReset")
                  : t("app.config.reset")
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
