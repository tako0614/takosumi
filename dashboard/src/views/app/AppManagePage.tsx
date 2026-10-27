/**
 * The installed-app page (TASK-0115): one page for keeping an installed app.
 *
 * Its sections follow what a person does with the app, not the control-plane
 * objects behind it: open it and see its state, deal with its problems,
 * update or change its version, change its settings and connections, see
 * what it created in their cloud and what that costs, see the apps it is
 * linked with, read its history, and uninstall it. Every change is reviewed
 * in place — the exact resource list and cost — and applies only from the
 * explicit "Allow and …" click; nothing is applied automatically and no
 * consent travels in a URL or storage.
 *
 * Used by the `/workloads/:id` route and, once an install completes, by the
 * install page, so an installed app reads the same wherever it is opened.
 */
import "./app-page.css";
import "../../styles/wave-a.css";
import "../../styles/wave-b.css";
import "../new/install-view.css";
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
  type JSX,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import { ExternalLink, RefreshCw } from "lucide-solid";
import AppFace from "../../components/AppFace.tsx";
import { Button, EmptyState, Skeleton, Toast } from "../../components/ui/index.ts";
import {
  cancelCapsuleUninstall,
  type Capsule,
  ControlApiError,
  createReviewableGitRevisionPlan,
  createStateVersionRollbackPlan,
  deleteCapsule,
  extractRunId,
  getCapsuleConfigurationContext,
  getCapsuleProviderBindingSet,
  getCapsuleUsageSummary,
  getCurrentResourceInventory,
  getInstallConfig,
  getWorkspaceGraph,
  INTERFACE_MATERIALIZATION_FAILURE_LIMIT,
  isInterfaceMaterializationRetryStale,
  listActivity,
  listInterfaceMaterializationFailures,
  listProviderConnections,
  listRuns,
  listSourceSnapshots,
  listSources,
  listStateVersions,
  planCapsule,
  retryInterfaceMaterializationFailure,
  type Run,
  setCapsuleAutoUpdate,
} from "../../lib/control-api.ts";
import {
  capsuleUninstallBanner,
  capsuleUninstallDependencyWarning,
  uninstallCancellable,
  uninstallDependencyReadWarning,
  uninstallTeardownFailed,
} from "../../lib/capsule-uninstall.ts";
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import { clearCapsuleListCache } from "../../lib/capsule-list.ts";
import { clearCurrentStateVersionCache } from "../../lib/current-state-versions.ts";
import { clearDashboardOverviewCache } from "../../lib/dashboard-overview.ts";
import { createLastGoodValue } from "../../lib/resource-read.ts";
import {
  getOrCreateRevisionPlanAttempt,
  type RevisionPlanAttempt,
} from "../../lib/revision-plan-attempt.ts";
import {
  installConfigRequiresUiSurface,
  listAuthorizedUiSurfaces,
} from "../../lib/ui-surface-interfaces.ts";
import {
  capsuleDisplayName,
  isCapsuleRuntimeOpenable,
  releaseActivationStatusForStateVersion,
} from "../../lib/capsules-ui.ts";
import { resolveAppIcon } from "../../lib/app-face.ts";
import {
  appHistory,
  appState,
  capsuleRuns,
  latestFailedRun,
  linkedApps,
  newerSnapshot,
  settledValue,
  stateVersionLabels,
} from "../../lib/app-page.ts";
import { listAppHostedResources } from "../../lib/app-hosted-resources.ts";
import { runFailureHint } from "../../lib/run-errors.ts";
import { locale, setDocumentTitle, t, type MessageKey } from "../../i18n/index.ts";
import InstallExecution, { type ReviewPurpose } from "../new/InstallExecution.tsx";
import { AppSection, OpenAppButton } from "./app-ui.tsx";
import AppVersionSection from "./AppVersionSection.tsx";
import AppSettingsSection from "./AppSettingsSection.tsx";
import AppCreatedSection from "./AppCreatedSection.tsx";
import AppHistorySection from "./AppHistorySection.tsx";
import AppLinkedSection from "./AppLinkedSection.tsx";

/** Workspace-wide runs read for this app's problems and history. */
export const APP_RUN_LOOKUP_LIMIT = 100;

export type ReviewSection = "problems" | "version" | "settings" | "uninstall";

interface ActiveReview {
  readonly section: ReviewSection;
  readonly purpose: ReviewPurpose;
  readonly planRunId: string;
  /** Recreates the same request when its review fails. */
  readonly restart?: () => Promise<string | undefined>;
}

const DONE_MESSAGE: Readonly<Record<ReviewPurpose, MessageKey>> = {
  install: "app.review.doneApply",
  update: "app.review.doneUpdate",
  apply: "app.review.doneApply",
  uninstall: "app.review.doneUninstall",
};

/** Route hash targets kept for old `/workloads/:id/:tab` links. */
const TAB_SECTIONS: Readonly<Record<string, string>> = {
  deploys: "app-version",
  settings: "app-settings",
  danger: "app-uninstall",
  history: "app-history",
};

/** True only for a genuine "this app does not exist" answer. */
function isCapsuleNotFound(error: unknown): boolean {
  return (
    error instanceof ControlApiError &&
    (error.status === 404 || error.code === "not_found")
  );
}

export default function AppManagePage(props: {
  readonly capsuleId: string;
  /** Signed-in principal, used to judge whether a screen should exist. */
  readonly principalId?: string;
  /** Old tab route segment; scrolls to the matching section. */
  readonly tab?: string;
  /** Shown once right after the install page applied the first install. */
  readonly justInstalled?: boolean;
}): JSX.Element {
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const capsuleId = () => props.capsuleId;

  const [context, { refetch: refetchContext }] = createResource(
    capsuleId,
    getCapsuleConfigurationContext,
  );
  // Never `context()`/`.latest` directly: both throw once a read failed. A
  // failed refetch keeps the last good app on screen with a quiet notice.
  const contextLatest = createLastGoodValue(
    context,
    (value) => value.capsule.id === capsuleId(),
  );
  const capsule = () => contextLatest()?.capsule;
  const authorityGuard = () => contextLatest()?.authorityGuard;
  const workspaceId = () => capsule()?.workspaceId;
  const applied = () => Boolean(capsule()?.currentStateVersionId);
  const destroyed = () => capsule()?.status === "destroyed";
  const managed = () => applied() && !destroyed();

  const [installConfig] = createResource(
    () => capsule()?.installConfigId ?? null,
    getInstallConfig,
  );
  const installConfigValue = () => settledValue(installConfig);
  const displayName = () =>
    capsuleDisplayName(installConfigValue(), locale()) ?? capsule()?.name ?? "";

  const [stateVersions, { refetch: refetchStateVersions }] = createResource(
    () => (applied() ? capsuleId() : null),
    listStateVersions,
  );
  const stateVersionList = () => settledValue(stateVersions) ?? [];
  const currentStateVersion = createMemo(() => {
    const id = capsule()?.currentStateVersionId;
    return id ? stateVersionList().find((version) => version.id === id) : undefined;
  });

  const [activity, { refetch: refetchActivity }] = createResource(
    () => workspaceId() ?? null,
    (id) => listActivity(id, 100),
  );
  const activityList = () => settledValue(activity) ?? [];

  const [runs, { refetch: refetchRuns }] = createResource(
    () => (destroyed() ? null : (workspaceId() ?? null)),
    (id) => listRuns(id, APP_RUN_LOOKUP_LIMIT),
  );
  const runList = () => settledValue(runs) ?? [];
  const appRuns = createMemo(() => capsuleRuns(runList(), capsuleId()));
  const failedRun = createMemo(() => latestFailedRun(appRuns()));

  const [surfaces, { refetch: refetchSurfaces }] = createResource(
    () => {
      const inst = capsule();
      return inst && managed()
        ? { workspaceId: inst.workspaceId, capsuleId: inst.id }
        : null;
    },
    (key) => listAuthorizedUiSurfaces(key.workspaceId, { capsuleId: key.capsuleId }),
  );
  const surfaceList = () => settledValue(surfaces) ?? [];
  // StateVersion is readiness/provenance only. URL and presentation authority
  // comes exclusively from the authorized Capsule-owned UI Interfaces above.
  const openable = createMemo(() =>
    isCapsuleRuntimeOpenable(
      capsule(),
      capsuleId(),
      currentStateVersion(),
      activityList(),
    ),
  );
  const activation = createMemo(() =>
    releaseActivationStatusForStateVersion(
      currentStateVersion(),
      activityList(),
      capsuleId(),
    ),
  );

  const [graph] = createResource(
    () => (destroyed() ? null : (workspaceId() ?? null)),
    getWorkspaceGraph,
  );
  const graphValue = () => settledValue(graph);
  const usesApps = createMemo(() => linkedApps(capsuleId(), graphValue(), "uses"));
  const usedByApps = createMemo(() => linkedApps(capsuleId(), graphValue(), "usedBy"));

  const [sources] = createResource(
    () => (managed() && capsule()?.sourceId ? (workspaceId() ?? null) : null),
    listSources,
  );
  const source = createMemo(() =>
    (settledValue(sources) ?? []).find((item) => item.id === capsule()?.sourceId),
  );
  const updateAvailable = () =>
    capsule() !== undefined && appState(capsule()!) === "update_available";
  const [snapshots] = createResource(
    () => {
      const inst = capsule();
      if (!inst?.sourceId || !managed()) return null;
      return updateAvailable() || stateVersionList().length > 1 ? inst.sourceId : null;
    },
    (id) => listSourceSnapshots(id),
  );
  const snapshotList = () => settledValue(snapshots) ?? [];
  const newVersion = createMemo(() =>
    newerSnapshot(snapshotList(), capsule()?.adoptedSourceRevision),
  );

  const [bindingSet, { refetch: refetchBindings }] = createResource(
    () => (managed() ? capsuleId() : null),
    getCapsuleProviderBindingSet,
  );
  const [connections, { refetch: refetchConnections }] = createResource(
    () => (managed() ? (workspaceId() ?? null) : null),
    listProviderConnections,
  );
  const [inventory, { refetch: refetchInventory }] = createResource(
    () => (managed() ? capsuleId() : null),
    getCurrentResourceInventory,
  );
  const [usage, { refetch: refetchUsage }] = createResource(
    () => (managed() ? capsuleId() : null),
    getCapsuleUsageSummary,
  );
  const [hosted] = createResource(
    () => {
      const inst = capsule();
      return inst && managed()
        ? { workspaceId: inst.workspaceId, capsuleId: inst.id }
        : null;
    },
    (key) => listAppHostedResources(key.workspaceId, key.capsuleId),
  );

  // Screen recovery is read only when there is a sign that a screen could not
  // be made openable: a dead-letter event for this app, or an app whose
  // definition declares a screen that the person cannot see.
  const screenMissing = createMemo(() => {
    if (!managed() || surfaces.loading || surfaces.error) return false;
    if (surfaceList().length > 0) return false;
    const config = installConfigValue();
    return Boolean(
      config && props.principalId &&
      installConfigRequiresUiSurface(config.interfaceBlueprints, {
        installingPrincipalId: props.principalId,
        repositoryInstallUxAccepted:
          config.installExperience?.repositoryInstallUx?.status === "accepted",
      }),
    );
  });
  const deadLettered = createMemo(() =>
    activityList().some(
      (event) =>
        event.action === "interface_materialization.dead_lettered" &&
        event.metadata.capsuleId === capsuleId(),
    ),
  );
  const [screenFailures, { refetch: refetchScreenFailures }] = createResource(
    () => (managed() && (deadLettered() || screenMissing()) ? (workspaceId() ?? null) : null),
    (id) =>
      listInterfaceMaterializationFailures(id, {
        limit: INTERFACE_MATERIALIZATION_FAILURE_LIMIT,
      }),
  );
  const appScreenFailures = () =>
    (settledValue(screenFailures) ?? []).filter(
      (failure) => failure.capsuleId === capsuleId(),
    );

  const versionLabels = createMemo(() =>
    stateVersionLabels({
      stateVersions: stateVersionList(),
      runs: runList(),
      snapshots: snapshotList(),
    }),
  );
  const history = createMemo(() =>
    appHistory({
      capsuleId: capsuleId(),
      stateVersions: stateVersionList(),
      runs: runList(),
      activity: activityList(),
      snapshots: snapshotList(),
    }),
  );

  createEffect(() => {
    const inst = capsule();
    if (inst) setDocumentTitle(displayName() || inst.name);
    else if (context.error) setDocumentTitle(t("app.notFound"));
  });

  // Old tab routes land on the matching section of this one page.
  createEffect(() => {
    const target = props.tab ? TAB_SECTIONS[props.tab] : undefined;
    if (!target || !capsule()) return;
    queueMicrotask(() =>
      document.getElementById(target)?.scrollIntoView({ block: "start", behavior: "instant" }),
    );
  });

  const clearCaches = () => {
    const workspace = workspaceId();
    if (!workspace) return;
    clearCapsuleListCache(workspace);
    clearCurrentStateVersionCache(workspace);
    clearDashboardOverviewCache(workspace);
  };

  const refreshAll = async () => {
    clearCaches();
    await Promise.allSettled([
      refetchContext(),
      refetchStateVersions(),
      refetchRuns(),
      refetchActivity(),
      refetchSurfaces(),
      refetchBindings(),
      refetchConnections(),
      refetchInventory(),
      refetchUsage(),
    ]);
  };

  // A scheduled uninstall and a first install finish server-side; keep the
  // page current while either is in progress.
  createEffect(() => {
    const inst = capsule();
    if (!inst) return;
    const state = appState(inst);
    if (state !== "uninstalling" && state !== "installing") return;
    const timer = setInterval(() => {
      if (!document.hidden && !context.loading) void refetchContext();
    }, inst.uninstall?.phase === "destroying" ? 5_000 : 30_000);
    onCleanup(() => clearInterval(timer));
  });

  // --- in-page reviews ---------------------------------------------------------
  const [review, setReview] = createSignal<ActiveReview>();
  const [starting, setStarting] = createSignal<ReviewSection>();
  const [sectionError, setSectionError] = createSignal<
    { readonly section: ReviewSection; readonly message: string }
  >();
  const [notice, setNotice] = createSignal<
    { readonly section: ReviewSection; readonly message: string }
  >();
  const reviewBusy = () => review() !== undefined || starting() !== undefined;
  const errorFor = (section: ReviewSection) =>
    sectionError()?.section === section ? sectionError()!.message : undefined;
  const noticeFor = (section: ReviewSection) =>
    notice()?.section === section ? notice()!.message : undefined;

  const startReview = async (
    section: ReviewSection,
    purpose: ReviewPurpose,
    create: () => Promise<string | undefined>,
    options: { readonly restartable?: boolean } = {},
  ) => {
    if (reviewBusy()) return;
    setStarting(section);
    setSectionError(undefined);
    setNotice(undefined);
    try {
      const planRunId = await create();
      if (!planRunId) throw new Error(t("app.review.notStarted"));
      setReview({
        section,
        purpose,
        planRunId,
        ...(options.restartable === false ? {} : { restart: create }),
      });
      queueMicrotask(() =>
        document.getElementById("app-review")?.scrollIntoView({ block: "nearest", behavior: "instant" }),
      );
    } catch (cause) {
      setSectionError({ section, message: friendlyError(cause, t).message });
    } finally {
      setStarting(undefined);
    }
  };

  const finishReview = (active: ActiveReview) => {
    setReview(undefined);
    setNotice({ section: active.section, message: t(DONE_MESSAGE[active.purpose]) });
    void refreshAll();
  };

  const reviewPanel = (section: ReviewSection) => (
    <Show when={review()?.section === section ? review() : undefined}>
      {(active) => (
        <div class="ap-review" id="app-review" data-testid="app-review" data-review-purpose={active().purpose}>
          <InstallExecution
            purpose={active().purpose}
            planRunId={active().planRunId}
            capsuleId={capsuleId()}
            onDone={() => finishReview(active())}
            onDiscard={async () => setReview(undefined)}
            onClose={() => setReview(undefined)}
            {...(active().restart
              ? {
                  onRestart: async () => {
                    const restarted = await active().restart!();
                    if (restarted) setReview({ ...active(), planRunId: restarted });
                  },
                  restartLabel: t("app.review.retry"),
                }
              : {})}
          />
        </div>
      )}
    </Show>
  );

  // --- version actions -----------------------------------------------------------
  // One request/key pair per ref tried in this app. The POST may have
  // committed before a later reconcile error reaches the browser, so even
  // definite HTTP errors must not discard a replay key.
  const revisionAttempts = new Map<string, RevisionPlanAttempt>();
  const currentRef = () =>
    capsule()?.adoptedSourceRevision?.ref ?? source()?.defaultRef;
  const revisionReady = () => {
    const ref = currentRef();
    return managed() && typeof ref === "string" && ref.trim().length > 0;
  };
  const createRevisionRun = async (requested?: string): Promise<string> => {
    const ref = (requested ?? currentRef())?.trim();
    if (!revisionReady() || !ref) {
      throw new ControlApiError(
        409,
        "revision_unavailable",
        "The installed version is not known yet.",
      );
    }
    const request = { ref } as const;
    const attempt = getOrCreateRevisionPlanAttempt(
      revisionAttempts,
      capsuleId(),
      JSON.stringify(request),
    );
    const response = await createReviewableGitRevisionPlan(capsuleId(), request, {
      idempotencyKey: attempt.idempotencyKey,
    });
    return response.revisionPlan.planRunId!;
  };
  const startUpdate = (ref?: string) =>
    void startReview("version", "update", () => createRevisionRun(ref));
  const startRollback = (stateVersionId: string) =>
    void startReview("version", "apply", async () =>
      extractRunId(await createStateVersionRollbackPlan(stateVersionId)),
    );
  const [autoUpdateBusy, setAutoUpdateBusy] = createSignal(false);
  const [autoUpdateError, setAutoUpdateError] = createSignal<string>();
  const toggleAutoUpdate = async (enabled: boolean) => {
    setAutoUpdateBusy(true);
    setAutoUpdateError(undefined);
    try {
      await setCapsuleAutoUpdate(capsuleId(), enabled);
      await refetchContext();
    } catch (cause) {
      setAutoUpdateError(friendlyError(cause, t).message);
    } finally {
      setAutoUpdateBusy(false);
    }
  };

  // --- problems ------------------------------------------------------------------
  const retryFailedRun = () =>
    void startReview("problems", "apply", async () =>
      extractRunId(await planCapsule(capsuleId())),
    );
  const [screenRetryBusy, setScreenRetryBusy] = createSignal(false);
  const [screenRetryMessage, setScreenRetryMessage] = createSignal<string>();
  const retryScreen = async () => {
    const failure = appScreenFailures()[0];
    const workspace = workspaceId();
    if (!failure || !workspace || screenRetryBusy()) return;
    setScreenRetryBusy(true);
    setScreenRetryMessage(undefined);
    try {
      await retryInterfaceMaterializationFailure(workspace, failure.id, {
        failureDigest: failure.failureDigest,
        stateVersionId: failure.stateVersionId,
        stateGeneration: failure.stateGeneration,
      });
      setScreenRetryMessage(t("app.problem.screenRetryQueued"));
    } catch (cause) {
      setScreenRetryMessage(
        isInterfaceMaterializationRetryStale(cause)
          ? t("app.problem.screenRetryStale")
          : friendlyError(cause, t).message,
      );
    } finally {
      setScreenRetryBusy(false);
      void refetchScreenFailures();
      void refetchSurfaces();
    }
  };

  // --- uninstall -------------------------------------------------------------------
  const [uninstallBusy, setUninstallBusy] = createSignal(false);
  const [uninstallError, setUninstallError] = createSignal<string>();
  const dependencyWarning = () =>
    capsuleUninstallDependencyWarning(
      displayName(),
      usedByApps().map((app) => app.name),
    );
  const dependencyCheck = () =>
    uninstallDependencyReadWarning(
      graph.error ? "failed" : graph.loading || graphValue() === undefined ? "loading" : "ready",
    );
  const uninstall = async () => {
    const inst = capsule();
    if (!inst || uninstallBusy()) return;
    const ok = await confirm({
      title: t("app.uninstall.confirmTitle"),
      message: [
        applied()
          ? t("app.uninstall.confirmMessage", { name: displayName() })
          : t("app.uninstall.confirmUnapplied", { name: displayName() }),
        dependencyWarning(),
        dependencyCheck(),
      ].filter(Boolean).join("\n\n"),
      confirmText: t("app.uninstall.cta"),
      cancelText: t("common.cancel"),
      danger: true,
    });
    if (!ok) return;
    setUninstallBusy(true);
    setUninstallError(undefined);
    try {
      const result = await deleteCapsule(inst.id);
      clearCaches();
      if (result.capsule?.status === "destroyed" || result.abandoned) {
        navigate("/", { replace: true });
        return;
      }
      await refetchContext();
    } catch (cause) {
      setUninstallError(friendlyError(cause, t).message);
    } finally {
      setUninstallBusy(false);
    }
  };
  const cancelUninstall = async () => {
    if (uninstallBusy()) return;
    setUninstallBusy(true);
    setUninstallError(undefined);
    try {
      await cancelCapsuleUninstall(capsuleId());
      clearCaches();
      await refetchContext();
    } catch (cause) {
      setUninstallError(friendlyError(cause, t).message);
    } finally {
      setUninstallBusy(false);
    }
  };
  const uninstallNow = () =>
    void startReview(
      "problems",
      "uninstall",
      async () => extractRunId(await deleteCapsule(capsuleId(), { immediate: true })),
      { restartable: false },
    );
  /** Mirrors the server rule: before teardown, or blocked before dispatch. */
  const teardownRunning = (inst: Capsule) =>
    inst.uninstall?.phase === "destroying" && inst.uninstall.blockedReason === undefined;

  // --- header ------------------------------------------------------------------------
  const iconUrl = () => {
    const surface = surfaceList()[0];
    const fromSurface = surface ? resolveAppIcon(surface.icon, surface.url) : {};
    return fromSurface.imageSrc ?? installConfigValue()?.store?.iconUrl;
  };
  const iconEmoji = () => {
    const surface = surfaceList()[0];
    return surface ? resolveAppIcon(surface.icon, surface.url).emoji : undefined;
  };
  const hasProblem = () =>
    Boolean(
      failedRun() ||
      appScreenFailures().length > 0 ||
      (managed() && activation() === "failed") ||
      capsule()?.status === "error",
    );
  const stateSentence = (): string => {
    const inst = capsule();
    if (!inst) return "";
    if (destroyed()) return t("app.state.sentence.uninstalled");
    const state = appState(inst);
    if (state === "uninstalling") return t("app.state.sentence.uninstalling");
    if (state === "installing") return t("app.state.sentence.installing");
    if (hasProblem() || state === "needs_attention") return t("app.state.sentence.needsAttention");
    if (state === "stopped") return t("app.state.sentence.stopped");
    if (activation() === "pending") return t("app.state.sentence.preparingScreen");
    if (state === "update_available") return t("app.state.sentence.updateAvailable");
    return t("app.state.sentence.ready");
  };

  return (
    <Switch>
      <Match when={context.loading && !contextLatest()}>
        <div class="ap-page">
          <Skeleton variant="block" />
        </div>
      </Match>
      <Match when={context.error && !contextLatest()}>
        <Show
          when={isCapsuleNotFound(context.error)}
          fallback={
            <EmptyState
              title={t("app.loadFailedTitle")}
              message={friendlyError(context.error, t).message}
              action={
                <Button variant="secondary" type="button" onClick={() => void refetchContext()}>
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
              <Button variant="secondary" href="/">
                {t("app.backHome")}
              </Button>
            }
          />
        </Show>
      </Match>
      <Match when={capsule()}>
        {(inst) => (
          <div class="ap-page" data-testid="app-page" data-app-state={destroyed() ? "uninstalled" : appState(inst())}>
            <Show when={context.error}>
              <Toast tone="error">{t("app.refreshFailed")}</Toast>
            </Show>
            <Show when={props.justInstalled && managed()}>
              <p class="ap-notice" role="status">{t("app.installedNotice")}</p>
            </Show>

            <header class="ap-header" data-testid="app-header">
              <AppFace
                name={displayName()}
                iconUrl={iconUrl()}
                emoji={iconEmoji()}
                class="ap-icon"
              />
              <div class="ap-title">
                <h1>
                  {displayName()}
                  <Show when={displayName() !== inst().name}>
                    <span class="ap-instance-name">{inst().name}</span>
                  </Show>
                </h1>
                <p class="ap-state" data-testid="app-state-sentence">{stateSentence()}</p>
              </div>
              <div class="ap-actions">
                <Show when={openable() && surfaceList().length > 0}>
                  <OpenAppButton surfaces={surfaceList()} appName={displayName()} />
                </Show>
                <Show when={updateAvailable() && revisionReady()}>
                  <Button
                    variant={openable() && surfaceList().length > 0 ? "secondary" : "primary"}
                    type="button"
                    icon={<RefreshCw size={16} />}
                    busy={starting() === "version"}
                    disabled={reviewBusy()}
                    onClick={() => {
                      startUpdate();
                      document.getElementById("app-version")?.scrollIntoView({ block: "start", behavior: "instant" });
                    }}
                  >
                    {t("app.version.update")}
                  </Button>
                </Show>
              </div>
            </header>

            <Show when={managed()}>
              <nav class="ap-jump" aria-label={t("app.jump.label")}>
                <a href="#app-version">{t("app.version.title")}</a>
                <a href="#app-settings">{t("app.settings.title")}</a>
                <a href="#app-created">{t("app.created.title")}</a>
                <a href="#app-history">{t("app.history.title")}</a>
                <a href="#app-uninstall">{t("app.uninstall.title")}</a>
              </nav>
            </Show>

            <Show when={destroyed()}>
              <AppSection id="app-gone" title={t("app.gone.title")} subtitle={t("app.gone.body")}>
                <div class="ap-row-actions">
                  <Button variant="primary" href="/">{t("app.backHome")}</Button>
                </div>
              </AppSection>
            </Show>

            {problemsSection()}

            <Show when={managed()}>
              <AppVersionSection
                capsule={inst()}
                sourceUrl={source()?.url}
                currentStateVersion={currentStateVersion()}
                stateVersions={stateVersionList()}
                stateVersionsLoading={stateVersions.loading}
                stateVersionsFailed={Boolean(stateVersions.error)}
                versionLabels={versionLabels()}
                newVersion={newVersion()}
                updateAvailable={updateAvailable()}
                dependencyChanged={updateAvailable() && !newVersion() && !snapshots.loading}
                revisionReady={revisionReady()}
                reviewBusy={reviewBusy()}
                starting={starting() === "version"}
                error={errorFor("version")}
                notice={noticeFor("version")}
                onUpdate={(ref) => startUpdate(ref)}
                onRollback={startRollback}
                autoUpdateBusy={autoUpdateBusy()}
                autoUpdateError={autoUpdateError()}
                onAutoUpdate={(enabled) => void toggleAutoUpdate(enabled)}
                review={reviewPanel("version")}
              />
              <AppSettingsSection
                capsuleId={capsuleId()}
                workspaceId={inst().workspaceId}
                installConfig={installConfigValue()}
                installConfigLoading={installConfig.loading}
                authorityGuard={authorityGuard()}
                bindings={settledValue(bindingSet)?.bindings}
                bindingsFailed={Boolean(bindingSet.error)}
                connections={settledValue(connections) ?? []}
                onConnectionsChanged={() => void refetchConnections()}
                reviewBusy={reviewBusy()}
                starting={starting() === "settings"}
                error={errorFor("settings")}
                notice={noticeFor("settings")}
                onReview={(create) => void startReview("settings", "apply", create, { restartable: false })}
                review={reviewPanel("settings")}
              />
              <AppCreatedSection
                inventory={settledValue(inventory)}
                inventoryLoading={inventory.loading}
                inventoryFailed={Boolean(inventory.error)}
                bindings={settledValue(bindingSet)?.bindings ?? []}
                connections={settledValue(connections) ?? []}
                usage={settledValue(usage)}
                usageLoading={usage.loading}
                usageFailed={Boolean(usage.error)}
                hosted={settledValue(hosted) ?? []}
              />
              <Show when={usesApps().length > 0 || usedByApps().length > 0}>
                <AppLinkedSection uses={usesApps()} usedBy={usedByApps()} />
              </Show>
            </Show>

            <Show when={!destroyed() || history().length > 0}>
              <AppHistorySection
                events={history()}
                loading={runs.loading || stateVersions.loading}
                partial={runList().length >= APP_RUN_LOOKUP_LIMIT}
              />
            </Show>

            <Show when={!destroyed() && appState(inst()) !== "uninstalling"}>
              <AppSection
                id="app-uninstall"
                title={t("app.uninstall.title")}
                subtitle={
                  applied()
                    ? t("app.uninstall.body", { name: displayName() })
                    : t("app.uninstall.bodyUnapplied", { name: displayName() })
                }
                testId="app-uninstall"
              >
                <Show when={usedByApps().length > 0}>
                  <div class="ap-impact" role="note">
                    <strong>{t("app.uninstall.impactTitle")}</strong>
                    <ul>
                      <For each={usedByApps()}>
                        {(app) => (
                          <li>
                            <a href={`/workloads/${encodeURIComponent(app.capsuleId)}`}>{app.name}</a>
                          </li>
                        )}
                      </For>
                    </ul>
                  </div>
                </Show>
                <Show when={dependencyCheck()}>
                  {(status) => <p class="ap-muted" role="status">{status()}</p>}
                </Show>
                <div class="ap-row-actions">
                  <Button
                    variant="danger"
                    type="button"
                    busy={uninstallBusy()}
                    disabled={uninstallBusy() || reviewBusy()}
                    onClick={() => void uninstall()}
                  >
                    {t("app.uninstall.cta")}
                  </Button>
                </div>
                <Show when={uninstallError()}>
                  {(message) => <p class="wa-error" role="alert">{message()}</p>}
                </Show>
              </AppSection>
            </Show>
          </div>
        )}
      </Match>
    </Switch>
  );

  function problemsSection(): JSX.Element {
    const inst = () => capsule()!;
    const scheduled = () =>
      inst().status === "uninstalled" || uninstallTeardownFailed(inst()) ||
      inst().uninstall?.phase === "destroying";
    const visible = () =>
      !destroyed() &&
      (scheduled() || !applied() || hasProblem() || review()?.section === "problems");
    return (
      <Show when={visible()}>
        <AppSection
          id="app-problems"
          title={t("app.problem.title")}
          testId="app-problems"
        >
          <div class="ap-problems">
            <Show when={scheduled()}>
              <article class="ap-problem ap-problem-warn" data-problem="uninstall">
                <strong>{capsuleUninstallBanner(inst(), displayName())}</strong>
                <Show when={uninstallExportNote(inst())}>
                  {(note) => <p>{note()}</p>}
                </Show>
                <div class="ap-row-actions">
                  <Show when={uninstallCancellable(inst())}>
                    <Button
                      variant="primary"
                      type="button"
                      busy={uninstallBusy()}
                      disabled={uninstallBusy()}
                      onClick={() => void cancelUninstall()}
                    >
                      {t("app.uninstall.cancel")}
                    </Button>
                  </Show>
                  <Show
                    when={
                      !teardownRunning(inst()) ||
                      uninstallTeardownFailed(inst())
                    }
                  >
                    <Button
                      variant={uninstallCancellable(inst()) ? "secondary" : "primary"}
                      type="button"
                      busy={starting() === "problems"}
                      disabled={reviewBusy()}
                      onClick={uninstallNow}
                    >
                      {t("app.uninstall.now")}
                    </Button>
                  </Show>
                </div>
                <Show when={uninstallError()}>
                  {(message) => <p class="wa-error" role="alert">{message()}</p>}
                </Show>
              </article>
            </Show>

            <Show when={!applied() && !scheduled()}>
              <article class="ap-problem" data-problem="install-incomplete">
                <strong>{t("app.problem.installIncomplete")}</strong>
                <p>
                  {failedRun()
                    ? runFailureHint(failedRun()!.errorCode)
                    : t("app.problem.installIncompleteHint")}
                </p>
                <div class="ap-row-actions">
                  <Button
                    variant="primary"
                    href={`/new?capsule=${encodeURIComponent(inst().id)}`}
                  >
                    {t("app.problem.continueInstall")}
                  </Button>
                </div>
              </article>
            </Show>

            <Show when={applied() && !scheduled() ? failedRun() : undefined} keyed>
              {(run) => failedRunCard(run)}
            </Show>

            <Show when={applied() && !scheduled() && !failedRun() && (inst()).status === "error"}>
              <article class="ap-problem" data-problem="error">
                <strong>{t("app.problem.error")}</strong>
                <p>{t("app.problem.errorHint")}</p>
              </article>
            </Show>

            <Show when={appScreenFailures()[0]}>
              {(failure) => (
                <article class="ap-problem" data-problem="screen">
                  <strong>{t("app.problem.screen")}</strong>
                  <p>{t("app.problem.screenHint")}</p>
                  <p class="ap-detail">
                    {t("app.problem.serverSaid")} <code>{failure().error.code}</code>
                  </p>
                  <div class="ap-row-actions">
                    <Button
                      variant="primary"
                      type="button"
                      busy={screenRetryBusy()}
                      disabled={screenRetryBusy()}
                      onClick={() => void retryScreen()}
                    >
                      {t("app.problem.screenRetry")}
                    </Button>
                  </div>
                  <Show when={screenRetryMessage()}>
                    {(message) => <p role="status">{message()}</p>}
                  </Show>
                </article>
              )}
            </Show>

            <Show when={managed() && activation() === "failed" && appScreenFailures().length === 0}>
              <article class="ap-problem" data-problem="activation">
                <strong>{t("app.problem.activation")}</strong>
                <p>{t("app.problem.activationHint")}</p>
                <Show when={currentStateVersion()?.createdByRunId}>
                  {(runId) => (
                    <div class="ap-row-actions">
                      <Button variant="secondary" href={`/runs/${encodeURIComponent(runId())}`} icon={<ExternalLink size={16} />}>
                        {t("app.problem.details")}
                      </Button>
                    </div>
                  )}
                </Show>
              </article>
            </Show>

            <Show when={errorFor("problems")}>
              {(message) => <p class="wa-error" role="alert">{message()}</p>}
            </Show>
            <Show when={noticeFor("problems")}>
              {(message) => <p class="ap-notice" role="status">{message()}</p>}
            </Show>
            {reviewPanel("problems")}
          </div>
        </AppSection>
      </Show>
    );
  }

  function failedRunCard(run: Run): JSX.Element {
    const removal = run.type === "destroy_plan" || run.type === "destroy_apply";
    const title = removal
      ? t("app.problem.uninstallFailed")
      : run.type === "apply"
        ? t("app.problem.applyFailed")
        : t("app.problem.reviewFailed");
    return (
      <article class="ap-problem" data-problem="failed-run">
        <strong>{title}</strong>
        <p>{runFailureHint(run.errorCode)}</p>
        <Show when={run.errorCode}>
          {(code) => (
            <p class="ap-detail">
              {t("app.problem.serverSaid")} <code>{code()}</code>
            </p>
          )}
        </Show>
        <div class="ap-row-actions">
          <Show when={!removal}>
            <Button
              variant="primary"
              type="button"
              busy={starting() === "problems"}
              disabled={reviewBusy()}
              onClick={retryFailedRun}
            >
              {t("app.problem.retry")}
            </Button>
          </Show>
          <Button
            variant={removal ? "primary" : "secondary"}
            href={`/runs/${encodeURIComponent(run.id)}`}
            icon={<ExternalLink size={16} />}
          >
            {t("app.problem.details")}
          </Button>
        </div>
      </article>
    );
  }
}

function uninstallExportNote(inst: Capsule): string | undefined {
  switch (inst.uninstall?.preDestroyExport?.status) {
    case "exported":
      return inst.uninstall.preDestroyExport.includesServiceData === false
        ? t("app.uninstall.exportExportedLedgerOnly")
        : t("app.uninstall.exportExported");
    case "failed":
      return t("app.uninstall.exportFailed");
    case "skipped":
      return t("app.uninstall.exportSkipped");
    default:
      return undefined;
  }
}
