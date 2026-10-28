/**
 * The installed-app page (TASK-0115): one page for keeping an installed app.
 *
 * The control plane computes the app's state, its one primary action, its
 * ordered problems, every screen it can open, its version facts, what is in
 * progress and the uninstall terms (`GET /capsules/:id/app`); this page shows
 * that view and turns each action into the matching in-page flow. Its
 * sections follow what a person does with the app: open it and see its
 * state, deal with its problems, update or change its version, change its
 * settings and connections, see what it created and what that costs, see the
 * apps it is linked with, read its history (`GET /capsules/:id/runs`, page by
 * page), and uninstall it. Every change is reviewed in place — the exact
 * resource list and cost — and applies only from the explicit "Allow and …"
 * click; nothing is applied automatically and no consent travels in a URL or
 * storage.
 *
 * Rendered by the canonical `/apps/:id` route and, once an install completes,
 * by the install page, so an installed app reads the same wherever it is
 * opened.
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
  on,
  onCleanup,
  Show,
  Switch,
  type JSX,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import { RefreshCw } from "lucide-solid";
import AppFace from "../../components/AppFace.tsx";
import { Button, EmptyState, Skeleton, Toast } from "../../components/ui/index.ts";
import {
  cancelCapsuleUninstall,
  type CapsuleAppAction,
  type CapsuleAppProblem,
  type CapsuleAppView,
  type Capsule,
  ControlApiError,
  createReviewableGitRevisionPlan,
  createStateVersionRollbackPlan,
  advanceGitInstallPlan,
  advanceGitRevisionPlan,
  deleteCapsule,
  extractRunId,
  getCapsule,
  getCapsuleApp,
  getCapsuleConfigurationContext,
  getCapsuleProviderBindingSet,
  getCapsuleUsageSummary,
  getCurrentResourceInventory,
  getInstallConfig,
  getRun,
  getWorkspaceGraph,
  isInterfaceMaterializationRetryStale,
  listCapsuleRuns,
  listProviderConnections,
  listSourceSnapshots,
  listStateVersions,
  planCapsule,
  retryInterfaceMaterializationFailure,
  type Run,
  type RunType,
  setCapsuleAutoUpdate,
} from "../../lib/control-api.ts";
import {
  capsuleUninstallDependencyWarning,
  uninstallDependencyReadWarning,
} from "../../lib/capsule-uninstall.ts";
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import { clearCapsuleListCache } from "../../lib/capsule-list.ts";
import { clearCurrentStateVersionCache } from "../../lib/current-state-versions.ts";
import { clearDashboardOverviewCache } from "../../lib/dashboard-overview.ts";
import { createLastGoodValue } from "../../lib/resource-read.ts";
import {
  getOrCreateRevisionPlanAttempt,
  releaseRevisionPlanAttempt,
  type RevisionPlanAttempt,
} from "../../lib/revision-plan-attempt.ts";
import { capsuleDisplayName } from "../../lib/capsules-ui.ts";
import {
  APP_HISTORY_RUN_TYPES,
  appPrimaryActionLabel,
  appPrimaryStep,
  appInstalledRef,
  appVersionChangeBusy,
  appRunHistory,
  type AppOlderHistory,
  appStateSentence,
  appViewIncomplete,
  isSettled,
  linkedApps,
  mergeAppHistoryPages,
  openableScreens,
  primaryProblem,
  reviewPurposeForRun,
  settledValue,
  stateVersionLabels,
} from "../../lib/app-page.ts";
import {
  APP_PAGE_SECTIONS,
  appPageHref,
  type AppPageSection,
  reinstallHref,
} from "../../lib/app-links.ts";
import { listAppHostedResources } from "../../lib/app-hosted-resources.ts";
import {
  defaultRetryPlanApi,
  previewRetryChange,
  retryPlanForRun,
  type RetryPlanApi,
} from "../../lib/run-retry.ts";
import { locale, setDocumentTitle, t, type MessageKey } from "../../i18n/index.ts";
import InstallExecution, { type ReviewPurpose } from "../new/InstallExecution.tsx";
import { AppSection, OpenAppButton } from "./app-ui.tsx";
import AppAttentionSection from "./AppAttentionSection.tsx";
import AppVersionSection from "./AppVersionSection.tsx";
import AppSettingsSection from "./AppSettingsSection.tsx";
import AppCreatedSection from "./AppCreatedSection.tsx";
import AppHistorySection from "./AppHistorySection.tsx";
import AppLinkedSection from "./AppLinkedSection.tsx";
import RunPolicyReasons from "./RunPolicyReasons.tsx";

/** Runs read per history page (the server accepts at most 100). */
export const APP_HISTORY_PAGE_SIZE = 20;

export type ReviewSection = "attention" | "version" | "settings";

interface ActiveReview {
  readonly section: ReviewSection;
  readonly purpose: ReviewPurpose;
  readonly planRunId: string;
  /** A run to follow first (an Apply already under way). */
  readonly initialRunId?: string;
  /** Recreates the same request when its review fails. */
  readonly restart?: () => Promise<string | undefined>;
  /** Opened because the server reported work in progress, not by a click. */
  readonly auto?: boolean;
}

const DONE_MESSAGE: Readonly<Record<ReviewPurpose, MessageKey>> = {
  install: "app.review.doneInstall",
  update: "app.review.doneUpdate",
  apply: "app.review.doneApply",
  uninstall: "app.review.doneUninstall",
};

/** States in which the server is still working on the app. */
const IN_PROGRESS_STATES = new Set<CapsuleAppView["state"]>([
  "installing",
  "updating",
  "uninstalling",
]);

/** True only for a genuine "this app does not exist" answer. */
function isCapsuleNotFound(error: unknown): boolean {
  return (
    error instanceof ControlApiError &&
    (error.status === 404 || error.code === "not_found")
  );
}

function scrollToSection(section: AppPageSection | "review") {
  const id = section === "review" ? "app-review" : APP_PAGE_SECTIONS[section];
  document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "instant" });
}

export default function AppManagePage(props: {
  readonly capsuleId: string;
  /** Signed-in principal (kept for embedding pages; screens come from the server). */
  readonly principalId?: string;
  /** The section the URL fragment names; scrolled to once the page settles. */
  readonly section?: AppPageSection;
  /** Shown once right after the install page applied the first install. */
  readonly justInstalled?: boolean;
  /** Every fresh read of the app, so an embedding page can follow it. */
  readonly onCapsule?: (capsule: Capsule) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const capsuleId = () => props.capsuleId;

  // --- the app and the server's view of it -----------------------------------
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

  const [appView, { refetch: refetchApp }] = createResource(capsuleId, getCapsuleApp);
  const app = createLastGoodValue(appView, (value) => value.capsuleId === capsuleId());
  const destroyed = () => app()?.state === "uninstalled";
  const applied = () => app()?.applied === true;
  const managed = () => applied() && !destroyed();
  const loadError = () => (contextLatest() ? undefined : context.error) ?? (app() ? undefined : appView.error);
  // Only the app's own record decides "not found": a view the server could
  // not serve (for example a skewed deploy) is unreadable, not missing.
  const notFound = () => !contextLatest() && isCapsuleNotFound(context.error);

  const [installConfig] = createResource(
    () => capsule()?.installConfigId ?? null,
    getInstallConfig,
  );
  const installConfigValue = () => settledValue(installConfig);
  const displayName = () =>
    app()?.displayName?.[locale()] ??
    capsuleDisplayName(installConfigValue(), locale()) ??
    capsule()?.name ?? "";

  const [stateVersions, { refetch: refetchStateVersions }] = createResource(
    () => (applied() ? capsuleId() : null),
    listStateVersions,
  );
  const stateVersionList = () => settledValue(stateVersions) ?? [];
  const currentStateVersion = createMemo(() => {
    const id = capsule()?.currentStateVersionId;
    return id ? stateVersionList().find((version) => version.id === id) : undefined;
  });

  const [graph, { refetch: refetchGraph }] = createResource(
    () => (destroyed() || !app() ? null : (workspaceId() ?? null)),
    getWorkspaceGraph,
  );
  const graphValue = () => settledValue(graph);
  const usesApps = createMemo(() => linkedApps(capsuleId(), graphValue(), "uses"));
  const usedByApps = createMemo(() => linkedApps(capsuleId(), graphValue(), "usedBy"));

  // Snapshots only name previous versions; the server already reports the
  // current and newest version.
  const [snapshots] = createResource(
    () => {
      const inst = capsule();
      return inst?.sourceId && managed() && stateVersionList().length > 1 ? inst.sourceId : null;
    },
    (id) => listSourceSnapshots(id),
  );
  const snapshotList = () => settledValue(snapshots) ?? [];

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

  // --- history: the app's own Runs, page by page --------------------------------
  const [historyFirst, { refetch: refetchHistory }] = createResource(capsuleId, (id) =>
    listCapsuleRuns(id, { limit: APP_HISTORY_PAGE_SIZE, types: APP_HISTORY_RUN_TYPES }),
  );
  const historyFirstValue = () => settledValue(historyFirst);
  // Older pages survive a refresh of the first page (see mergeAppHistoryPages).
  const [olderRuns, setOlderRuns] = createSignal<AppOlderHistory>();
  const historyPages = createMemo(() => mergeAppHistoryPages(historyFirstValue(), olderRuns()));
  const historyRuns = () => historyPages().runs;
  const historyCursor = () => historyPages().nextCursor;
  const [moreBusy, setMoreBusy] = createSignal(false);
  const [moreError, setMoreError] = createSignal<string>();
  const loadMoreHistory = async () => {
    const cursor = historyCursor();
    if (!cursor || moreBusy()) return;
    const forCapsule = capsuleId();
    setMoreBusy(true);
    setMoreError(undefined);
    try {
      const page = await listCapsuleRuns(forCapsule, {
        limit: APP_HISTORY_PAGE_SIZE,
        cursor,
        types: APP_HISTORY_RUN_TYPES,
      });
      if (capsuleId() !== forCapsule || historyCursor() !== cursor) return;
      // Continue the older pages when this cursor came from them; otherwise
      // (the first page moved past them) start the older pages afresh.
      const previous = olderRuns()?.nextCursor === cursor ? olderRuns() : undefined;
      setOlderRuns({
        startCursor: previous?.startCursor ?? cursor,
        runs: [...(previous?.runs ?? []), ...page.runs],
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
    } catch (cause) {
      if (capsuleId() === forCapsule) setMoreError(friendlyError(cause, t).message);
    } finally {
      if (capsuleId() === forCapsule) setMoreBusy(false);
    }
  };

  const versionLabels = createMemo(() =>
    stateVersionLabels({
      stateVersions: stateVersionList(),
      runs: historyRuns(),
      snapshots: snapshotList(),
    }),
  );
  const history = createMemo(() => {
    const current = app()?.version.current;
    return appRunHistory({
      runs: historyRuns(),
      stateVersions: stateVersionList(),
      snapshots: snapshotList(),
      ...(current
        ? {
            current: {
              ...(capsule()?.currentStateVersionId
                ? { stateVersionId: capsule()!.currentStateVersionId! }
                : {}),
              ref: current.ref,
              commit: current.commit,
            },
          }
        : {}),
    });
  });

  createEffect(() => {
    const inst = capsule();
    if (inst) setDocumentTitle(displayName() || inst.name);
    else if (context.error) setDocumentTitle(t("app.notFound"));
  });

  createEffect(() => {
    const inst = capsule();
    if (inst) props.onCapsule?.(inst);
  });

  // The section the URL names is scrolled to once the sections above it have
  // loaded and stopped moving it down.
  let scrolledTo: string | undefined;
  createEffect(() => {
    const section = props.section;
    if (!section || !capsule() || !app()) return;
    const key = `${capsuleId()}:${section}`;
    if (scrolledTo === key) return;
    const settling = [installConfig, stateVersions, graph, inventory, bindingSet, usage, historyFirst]
      .some((resource) => resource.loading);
    if (settling) return;
    scrolledTo = key;
    requestAnimationFrame(() => scrollToSection(section));
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
      refetchApp(),
      refetchContext(),
      refetchStateVersions(),
      refetchHistory(),
      refetchBindings(),
      refetchConnections(),
      refetchInventory(),
      refetchUsage(),
      refetchGraph(),
    ]);
  };

  // While the server is working on the app, keep its view current; when that
  // work ends, re-read every section so they show what it changed.
  createEffect(() => {
    const view = app();
    if (!view) return;
    const working = IN_PROGRESS_STATES.has(view.state) || view.progress.revisionPreparing ||
      view.uninstall.scheduled?.phase === "destroying";
    if (!working) return;
    const fast = view.progress.run !== undefined || view.uninstall.scheduled?.phase === "destroying";
    const timer = setInterval(() => {
      if (!document.hidden && !appView.loading) void refetchApp();
    }, fast ? 5_000 : 15_000);
    onCleanup(() => clearInterval(timer));
  });
  createEffect(
    on(
      () => {
        const view = app();
        return view ? IN_PROGRESS_STATES.has(view.state) : undefined;
      },
      (working, wasWorking) => {
        if (wasWorking === true && working === false) void refreshAll();
      },
      { defer: true },
    ),
  );

  // --- in-page reviews ---------------------------------------------------------
  const [review, setReview] = createSignal<ActiveReview>();
  const [starting, setStarting] = createSignal<
    { readonly section: ReviewSection; readonly action?: CapsuleAppAction | "continue_revision" }
  >();
  const [sectionError, setSectionError] = createSignal<
    { readonly section: ReviewSection; readonly message: string }
  >();
  const [notice, setNotice] = createSignal<
    { readonly section: ReviewSection; readonly message: string }
  >();
  // An automatically opened review of a first install never blocks other
  // actions, such as uninstalling an app that was never applied. A change the
  // server is applying to an installed app does.
  const reviewBusy = () =>
    starting() !== undefined ||
    (review() !== undefined && (review()!.auto !== true || app()?.state !== "installing"));
  // Bumped when a settings review closes unapplied, so the form shows what
  // the app actually runs rather than edits that were never applied.
  const [settingsSeed, setSettingsSeed] = createSignal(0);
  // Reviews of in-progress work the person closed are not reopened for them.
  const dismissedRuns = new Set<string>();
  const closeReview = (active: ActiveReview) => {
    setReview(undefined);
    dismissedRuns.add(active.initialRunId ?? active.planRunId);
    if (active.section === "settings") setSettingsSeed((value) => value + 1);
  };
  // A review, its errors and notices belong to one app. If this page is
  // handed another app, none of them carry over.
  createEffect(
    on(
      capsuleId,
      () => {
        setReview(undefined);
        setStarting(undefined);
        setSectionError(undefined);
        setNotice(undefined);
        setUninstallError(undefined);
        setAutoUpdateError(undefined);
        setScreenRetryMessage(undefined);
        setOlderRuns(undefined);
        setMoreError(undefined);
        dismissedRuns.clear();
      },
      { defer: true },
    ),
  );
  const errorFor = (section: ReviewSection) =>
    sectionError()?.section === section ? sectionError()!.message : undefined;
  const noticeFor = (section: ReviewSection) =>
    notice()?.section === section ? notice()!.message : undefined;
  const startingIn = (section: ReviewSection) => starting()?.section === section;

  const startReview = async (
    section: ReviewSection,
    purpose: ReviewPurpose,
    create: () => Promise<string | undefined>,
    options: { readonly restartable?: boolean; readonly action?: CapsuleAppAction | "continue_revision" } = {},
  ) => {
    if (reviewBusy()) return;
    // A result that arrives after the page moved to another app is dropped.
    const forCapsule = capsuleId();
    setStarting({ section, ...(options.action ? { action: options.action } : {}) });
    setSectionError(undefined);
    setNotice(undefined);
    try {
      const planRunId = await create();
      if (capsuleId() !== forCapsule) return;
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
      if (capsuleId() === forCapsule) {
        setSectionError({ section, message: friendlyError(cause, t).message });
      }
    } finally {
      if (capsuleId() === forCapsule) setStarting(undefined);
    }
  };

  // After a review ends, a poll that started before it ended may still report
  // the run it followed as in progress. Work is not followed again until the
  // fresh read that the end triggers has landed.
  const [autoOpenHeld, setAutoOpenHeld] = createSignal(false);
  const refreshAfterReview = () => {
    setAutoOpenHeld(true);
    void refreshAll().finally(() => setAutoOpenHeld(false));
  };
  const finishReview = (active: ActiveReview) => {
    setReview(undefined);
    dismissedRuns.add(active.initialRunId ?? active.planRunId);
    setNotice({ section: active.section, message: t(DONE_MESSAGE[active.purpose]) });
    refreshAfterReview();
  };

  /** Opens the review of a run the server named (a plan waiting, a blocked plan). */
  const openRunReview = (runId: string, runType: RunType) => {
    if (reviewBusy()) return;
    setSectionError(undefined);
    setNotice(undefined);
    setReview({
      section: "attention",
      purpose: reviewPurposeForRun(runType, applied()),
      planRunId: runId,
    });
    queueMicrotask(() => scrollToSection("review"));
  };

  // Work the server reports in progress on an app that is not usable yet
  // (an install waiting for review or running), or a change being applied,
  // is followed in place. Only the explicit Allow click applies anything.
  createEffect(() => {
    const view = app();
    if (!view || review() || starting() || autoOpenHeld()) return;
    if (view.state !== "installing" && view.state !== "updating") return;
    const target = view.progress.review
      ? { runId: view.progress.review.runId, runType: view.progress.review.runType }
      : view.progress.run
        ? { runId: view.progress.run.id, runType: view.progress.run.type }
        : undefined;
    if (!target || dismissedRuns.has(target.runId)) return;
    setReview({
      section: "attention",
      purpose: reviewPurposeForRun(target.runType, view.applied),
      planRunId: target.runId,
      initialRunId: target.runId,
      auto: true,
    });
  });

  const policyReasonsOnCard = (runId: string) =>
    app()?.problems.some((problem) => problem.code === "policy_blocked" && problem.runId === runId) === true;
  const reviewPanel = (section: ReviewSection) => (
    <Show when={review()?.section === section ? review() : undefined}>
      {(active) => (
        <div class="ap-review" id="app-review" data-testid="app-review" data-review-purpose={active().purpose}>
          {/* A blocked plan's problem card already names its reasons. */}
          <Show when={!policyReasonsOnCard(active().planRunId)}>
            <RunPolicyReasons runId={active().planRunId} capsuleId={capsuleId()} />
          </Show>
          <InstallExecution
            purpose={active().purpose}
            planRunId={active().planRunId}
            {...(active().initialRunId ? { initialRunId: active().initialRunId! } : {})}
            capsuleId={capsuleId()}
            onDone={() => finishReview(active())}
            // An install review has nothing to cancel on this page: the app
            // stays installable, and Uninstall removes it.
            {...(active().purpose === "install" ? {} : { onDiscard: async () => closeReview(active()) })}
            // Closing after an unknown or failed outcome re-reads the app so
            // its state, problems and history show what actually happened.
            onClose={() => {
              closeReview(active());
              refreshAfterReview();
            }}
            {...(active().restart
              ? {
                  onRestart: async () => {
                    const forCapsule = capsuleId();
                    const current = active();
                    const restarted = await current.restart!();
                    if (restarted && capsuleId() === forCapsule) {
                      // A restarted review follows its new Plan from the start.
                      setReview({
                        section: current.section,
                        purpose: current.purpose,
                        planRunId: restarted,
                        ...(current.restart ? { restart: current.restart } : {}),
                      });
                    }
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
  // One request/key pair per ref while its outcome is unknown or failed: the
  // POST may have committed before a later reconcile error reaches the
  // browser. Once a Plan id comes back the key is released, so the next
  // Update / Review again / later update to the same ref is a new request
  // instead of a replay of the plan already returned.
  const revisionAttempts = new Map<string, RevisionPlanAttempt>();
  // The installed ref, from the server's view or the Capsule's adopted
  // revision. An installed app never falls back to the Source's default ref:
  // without a known ref there is nothing to update.
  const currentRef = () => appInstalledRef(app(), capsule());
  const revisionReady = () => {
    const ref = currentRef();
    return managed() && typeof ref === "string" && ref.trim().length > 0;
  };
  const createRevisionRun = async (requested?: string): Promise<string> => {
    const ref = (requested ?? currentRef())?.trim();
    if (!managed() || !ref) {
      throw new ControlApiError(
        409,
        "revision_unavailable",
        "The installed version is not known yet.",
      );
    }
    const request = { ref } as const;
    const requestJson = JSON.stringify(request);
    const forCapsule = capsuleId();
    const attempt = getOrCreateRevisionPlanAttempt(revisionAttempts, forCapsule, requestJson);
    const response = await createReviewableGitRevisionPlan(forCapsule, request, {
      idempotencyKey: attempt.idempotencyKey,
    });
    const planRunId = response.revisionPlan.planRunId;
    if (planRunId) releaseRevisionPlanAttempt(revisionAttempts, forCapsule, requestJson);
    return planRunId!;
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
      await Promise.allSettled([refetchContext(), refetchApp()]);
    } catch (cause) {
      setAutoUpdateError(friendlyError(cause, t).message);
    } finally {
      setAutoUpdateBusy(false);
    }
  };

  // --- the actions the server names ------------------------------------------------
  // "Review again" plans the failed run as the same change, the way the run
  // page does (lib/run-retry.ts): a removal as a removal, a first install with
  // its reviewed report, a version change to the same ref (with this page's
  // idempotency key), a rollback to the same version. Without a run, or for a
  // configuration change, the installed version is planned again with the
  // current configuration — never the Source's default ref. The app is re-read
  // first.
  const retryApi: RetryPlanApi = {
    ...defaultRetryPlanApi(),
    planRevision: (_capsuleId, ref) => createRevisionRun(ref),
  };
  const retry = (problem: CapsuleAppProblem | undefined) => {
    const runId = problem?.runId;
    const removal = problem?.runType === "destroy_plan" || problem?.runType === "destroy_apply";
    const purpose: ReviewPurpose = removal ? "uninstall" : applied() ? "apply" : "install";
    void startReview("attention", purpose, async () => {
      if (!runId) {
        if (!applied()) return extractRunId(await planCapsule(capsuleId()));
        const installed = (await getCapsule(capsuleId())).currentStateVersionId;
        if (!installed) throw new Error(t("app.review.notStarted"));
        return extractRunId(await createStateVersionRollbackPlan(installed));
      }
      const run = await getRun(runId);
      const fresh = await getCapsule(run.capsuleId ?? capsuleId());
      return await retryPlanForRun(run, fresh, retryApi);
    }, { action: "retry" });
  };
  // Continuing an install advances the install attempt that owns this app
  // (its own reconciliation), never a plan beside it; only an app with no
  // attempt left is planned from its saved settings.
  // What "Review again" would plan for the server's primary problem, so a
  // re-plan of the installed version is labelled as such, not as a retry of
  // a change the failed plan never recorded.
  const [retryPreview] = createResource(
    () => {
      const view = app();
      const problem = view && primaryProblem(view);
      const inst = capsule();
      return view?.applied && view.primaryAction === "retry" && problem?.runId && inst
        ? { runId: problem.runId, inst }
        : null;
    },
    async ({ runId, inst }) => previewRetryChange(await getRun(runId), inst),
  );
  const retryLabel = (view: CapsuleAppView): MessageKey => {
    if (view.primaryAction !== "retry" || !view.applied) return "app.problem.retry";
    if (!primaryProblem(view)?.runId) return "app.problem.retryInstalled";
    const preview = retryPreview.state === "ready" ? retryPreview() : undefined;
    return preview?.kind === "installed" && !preview.recorded
      ? "app.problem.retryInstalled"
      : "app.problem.retry";
  };
  const continueInstall = () =>
    void startReview(
      "attention",
      "install",
      async () => {
        const attempt = app()?.progress.installPlanId;
        if (!attempt) return extractRunId(await planCapsule(capsuleId()));
        const advanced = await advanceGitInstallPlan(attempt);
        // An attempt that now waits for input is answered by whoever started it.
        if (!advanced.installPlan.planRunId) throw new Error(t("app.problem.installNeedsInput"));
        return advanced.installPlan.planRunId;
      },
      { action: "continue_install" },
    );
  // A version change whose preparation stopped is continued through its own
  // coordinator, then reviewed in place like any update.
  const continueRevision = (revisionPlanId: string) =>
    void startReview(
      "attention",
      "update",
      async () => (await advanceGitRevisionPlan(revisionPlanId)).revisionPlan.planRunId,
      { action: "continue_revision", restartable: false },
    );
  const [screenRetryBusy, setScreenRetryBusy] = createSignal(false);
  const [screenRetryMessage, setScreenRetryMessage] = createSignal<string>();
  const retryScreen = async (problem: CapsuleAppProblem | undefined) => {
    const failure = problem?.screenFailure;
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
      void refetchApp();
    }
  };
  const fixConnection = () => {
    if (managed()) scrollToSection("connections");
    else navigate("/connections");
  };

  // --- uninstall -------------------------------------------------------------------
  const [uninstallBusy, setUninstallBusy] = createSignal(false);
  const [uninstallError, setUninstallError] = createSignal<string>();
  const graceDays = () => {
    const terms = app()?.uninstall;
    return terms?.mode === "scheduled" ? terms.graceDays : undefined;
  };
  const dependencyWarning = () =>
    capsuleUninstallDependencyWarning(
      displayName(),
      usedByApps().map((linked) => linked.name),
    );
  const dependencyCheck = () =>
    uninstallDependencyReadWarning(
      graph.error ? "failed" : graph.loading || graphValue() === undefined ? "loading" : "ready",
    );
  const uninstall = async () => {
    const inst = capsule();
    if (!inst || uninstallBusy()) return;
    // Name the apps it affects from a fresh read, right before confirming.
    setUninstallBusy(true);
    await Promise.resolve(refetchGraph()).catch(() => undefined);
    setUninstallBusy(false);
    const days = graceDays();
    const ok = await confirm({
      title: t("app.uninstall.confirmTitle"),
      message: [
        !applied()
          ? t("app.uninstall.confirmUnapplied", { name: displayName() })
          : days !== undefined
            ? t("app.uninstall.confirmGrace", { name: displayName(), days })
            : t("app.uninstall.confirmMessage", { name: displayName() }),
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
      await Promise.allSettled([refetchContext(), refetchApp()]);
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
      await Promise.allSettled([refetchContext(), refetchApp(), refetchHistory()]);
    } catch (cause) {
      setUninstallError(friendlyError(cause, t).message);
    } finally {
      setUninstallBusy(false);
    }
  };
  // The immediate teardown is a plan reviewed in place: its removal list,
  // the explicit check and the approval dialog all stay in front of it.
  const uninstallNow = () =>
    void startReview(
      "attention",
      "uninstall",
      async () => extractRunId(await deleteCapsule(capsuleId(), { immediate: true })),
      { restartable: false, action: "uninstall_now" },
    );

  // --- the one primary action ---------------------------------------------------------
  const runPrimary = (view: CapsuleAppView) => {
    const step = appPrimaryStep(view);
    switch (step.kind) {
      case "show_created":
        scrollToSection("created");
        return;
      case "review":
        openRunReview(step.runId, step.runType);
        return;
      case "retry":
        retry(step.problem);
        return;
      case "retry_screen":
        void retryScreen(step.problem);
        return;
      case "fix_connection":
        fixConnection();
        return;
      case "continue_install":
        continueInstall();
        return;
      case "cancel_uninstall":
        void cancelUninstall();
        return;
      case "uninstall_now":
        uninstallNow();
        return;
      default:
        // `open` and `reinstall` are links; `none` has nothing to do.
        return;
    }
  };
  /** The primary action's own review is already open below the header. */
  const primaryOpenInPlace = (view: CapsuleAppView) =>
    view.primaryAction === "review" && review()?.section === "attention";
  const primaryBusy = (view: CapsuleAppView) =>
    starting()?.action === view.primaryAction ||
    (view.primaryAction === "cancel_uninstall" && uninstallBusy()) ||
    (view.primaryAction === "retry_screen" && screenRetryBusy());

  // --- header ------------------------------------------------------------------------
  const screens = () => openableScreens(app()?.screens ?? []);
  /** What installing again pre-fills: the repository, last ref and paths. */
  const reinstallInput = (view: CapsuleAppView, inst: Capsule) => {
    const config = installConfigValue();
    const repositoryUrl = view.version.repository?.url ?? config?.sourceSelector?.url;
    const ref = view.version.current?.ref ?? inst.adoptedSourceRevision?.ref;
    const sourcePath = view.version.current?.path ?? config?.sourceSelector?.path;
    return {
      ...(repositoryUrl ? { repositoryUrl } : {}),
      ...(ref ? { ref } : {}),
      ...(sourcePath ? { sourcePath } : {}),
      ...(config?.modulePath ? { path: config.modulePath } : {}),
      name: inst.name,
    };
  };
  const iconUrl = () => {
    const icon = app()?.screens[0]?.icon;
    return icon?.kind === "image" ? icon.url : app()?.iconUrl ?? installConfigValue()?.store?.iconUrl;
  };
  const iconEmoji = () => {
    const icon = app()?.screens[0]?.icon;
    return icon?.kind === "glyph" ? icon.glyph : undefined;
  };
  /** Open as a secondary action: screens listed, primary is something else. */
  const secondaryScreens = (view: CapsuleAppView) =>
    view.primaryAction !== "open" && screens().length > 0 &&
    view.state !== "uninstalling" && view.state !== "uninstalled";
  const versionChangeBusy = appVersionChangeBusy;
  const showUpdate = (view: CapsuleAppView) =>
    managed() && revisionReady() && (view.version.updateAvailable || view.version.stale) &&
    view.state === "installed" && !versionChangeBusy(view);

  return (
    <Switch>
      <Match when={!loadError() && (!contextLatest() || !app())}>
        <div class="ap-page">
          <Skeleton variant="block" />
        </div>
      </Match>
      <Match when={loadError()}>
        {(error) => (
          <Show
            when={notFound()}
            fallback={
              <EmptyState
                title={t("app.loadFailedTitle")}
                message={friendlyError(error(), t).message}
                action={
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={() => void Promise.allSettled([refetchContext(), refetchApp()])}
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
                <Button variant="secondary" href="/">
                  {t("app.backHome")}
                </Button>
              }
            />
          </Show>
        )}
      </Match>
      <Match when={capsule() && app() ? { inst: capsule()!, view: app()! } : undefined}>
        {(loaded) => {
          const inst = () => loaded().inst;
          const view = () => loaded().view;
          const primaryLabel = () =>
            view().primaryAction === "retry" ? retryLabel(view()) : appPrimaryActionLabel(view().primaryAction);
          return (
            <div class="ap-page" data-testid="app-page" data-app-state={view().state} data-primary-action={view().primaryAction}>
              <Show when={context.error || appView.error}>
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
                  <p class="ap-state" data-testid="app-state-sentence">{t(appStateSentence(view()))}</p>
                  <Show when={appViewIncomplete(view(), "screens")}>
                    <p class="ap-muted" role="alert" data-incomplete="screens">{t("app.incomplete.screens")}</p>
                  </Show>
                  <Show when={appViewIncomplete(view(), "display")}>
                    <p class="ap-muted" role="status" data-incomplete="display">{t("app.incomplete.display")}</p>
                  </Show>
                </div>
                <div class="ap-actions" data-testid="app-primary">
                  <Switch>
                    <Match when={view().primaryAction === "open" && screens().length > 0}>
                      <OpenAppButton surfaces={screens()} appName={displayName()} />
                    </Match>
                    <Match when={view().primaryAction === "reinstall"}>
                      <Button
                        variant="primary"
                        href={reinstallHref(reinstallInput(view(), inst()))}
                      >
                        {t("app.action.reinstall")}
                      </Button>
                    </Match>
                    <Match when={!primaryOpenInPlace(view()) && primaryLabel()}>
                      {(label) => (
                        <Button
                          variant={view().primaryAction === "uninstall_now" ? "danger" : "primary"}
                          type="button"
                          busy={primaryBusy(view())}
                          disabled={reviewBusy() || uninstallBusy()}
                          onClick={() => runPrimary(view())}
                        >
                          {t(label())}
                        </Button>
                      )}
                    </Match>
                  </Switch>
                  {/* Screens the server still lists stay openable while
                      another action is primary: an app that needs attention
                      may keep serving its last successful version. */}
                  <Show when={secondaryScreens(view())}>
                    <OpenAppButton surfaces={screens()} appName={displayName()} variant="secondary" />
                  </Show>
                  <Show when={appViewIncomplete(view(), "screens")}>
                    <Button
                      variant="secondary"
                      type="button"
                      busy={appView.loading}
                      onClick={() => void refetchApp()}
                    >
                      {t("app.open.reload")}
                    </Button>
                  </Show>
                  <Show when={showUpdate(view())}>
                    <Button
                      variant="secondary"
                      type="button"
                      icon={<RefreshCw size={16} />}
                      busy={startingIn("version")}
                      disabled={reviewBusy()}
                      onClick={() => {
                        startUpdate();
                        scrollToSection("version");
                      }}
                    >
                      {t("app.version.update")}
                    </Button>
                  </Show>
                </div>
              </header>

              <Show when={managed()}>
                <nav class="ap-jump" aria-label={t("app.jump.label")}>
                  <a href="#version">{t("app.version.title")}</a>
                  <a href="#settings">{t("app.settings.title")}</a>
                  <a href="#created">{t("app.created.title")}</a>
                  <a href="#history">{t("app.history.title")}</a>
                  <Show when={!view().uninstall.scheduled}>
                    <a href="#danger">{t("app.uninstall.title")}</a>
                  </Show>
                </nav>
              </Show>

              <Show when={destroyed()}>
                <AppSection id="app-gone" title={t("app.gone.title")} subtitle={t("app.gone.body")}>
                  <div class="ap-row-actions">
                    <Button variant="secondary" href="/">{t("app.backHome")}</Button>
                  </div>
                </AppSection>
              </Show>

              <AppAttentionSection
                app={view()}
                displayName={displayName()}
                busy={reviewBusy() || uninstallBusy()}
                {...(starting()?.section === "attention" && starting()?.action
                  ? { startingAction: starting()!.action! }
                  : {})}
                uninstallBusy={uninstallBusy()}
                {...(uninstallError() ? { uninstallError: uninstallError()! } : {})}
                screenRetryBusy={screenRetryBusy()}
                {...(screenRetryMessage() ? { screenRetryMessage: screenRetryMessage()! } : {})}
                {...(errorFor("attention") ? { error: errorFor("attention")! } : {})}
                {...(noticeFor("attention") ? { notice: noticeFor("attention")! } : {})}
                {...(review()?.section === "attention"
                  ? { reviewRunId: review()!.initialRunId ?? review()!.planRunId }
                  : {})}
                review={reviewPanel("attention")}
                actions={{
                  retry,
                  retryScreen: (problem) => void retryScreen(problem),
                  fixConnection,
                  continueInstall,
                  cancelUninstall: () => void cancelUninstall(),
                  uninstallNow,
                  openReview: openRunReview,
                  continueRevision,
                }}
              />

              <Show when={managed()}>
                <AppVersionSection
                  version={view().version}
                  versionIncomplete={appViewIncomplete(view(), "version")}
                  currentStateVersion={currentStateVersion()}
                  stateVersions={stateVersionList()}
                  stateVersionsLoading={stateVersions.loading}
                  stateVersionsFailed={Boolean(stateVersions.error)}
                  versionLabels={versionLabels()}
                  revisionReady={revisionReady()}
                  reviewBusy={reviewBusy() || versionChangeBusy(view())}
                  starting={startingIn("version")}
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
                  // A loaded app without a binding set uses no connections.
                  bindings={isSettled(bindingSet) ? (settledValue(bindingSet)?.bindings ?? []) : undefined}
                  capsuleInstallConfigId={inst().installConfigId}
                  seed={settingsSeed()}
                  bindingsFailed={Boolean(bindingSet.error)}
                  connections={settledValue(connections) ?? []}
                  onConnectionsChanged={() => void refetchConnections()}
                  reviewBusy={reviewBusy()}
                  starting={startingIn("settings")}
                  error={errorFor("settings")}
                  notice={noticeFor("settings")}
                  onReview={(create) => void startReview("settings", "apply", create, { restartable: false })}
                  review={reviewPanel("settings")}
                />
                <AppCreatedSection
                  inventory={settledValue(inventory)}
                  inventoryLoading={inventory.loading}
                  inventoryFailed={Boolean(inventory.error)}
                  bindings={isSettled(bindingSet) ? (settledValue(bindingSet)?.bindings ?? []) : []}
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

              <AppHistorySection
                events={history()}
                loading={historyFirst.loading && !historyFirstValue()}
                failed={Boolean(historyFirst.error) && !historyFirstValue()}
                onReload={() => void refetchHistory()}
                hasMore={historyCursor() !== undefined}
                moreBusy={moreBusy()}
                moreError={moreError()}
                onMore={() => void loadMoreHistory()}
              />

              <Show
                when={
                  !destroyed() && !view().uninstall.scheduled &&
                  view().state !== "uninstalling" && view().state !== "uninstall_scheduled"
                }
              >
                <AppSection
                  id="danger"
                  title={t("app.uninstall.title")}
                  subtitle={
                    view().uninstall.mode === "discard"
                      ? t("app.uninstall.bodyUnapplied", { name: displayName() })
                      : view().uninstall.mode === "none"
                        ? t("app.uninstall.bodyImmediate", { name: displayName() })
                        : graceDays() !== undefined
                          ? t("app.uninstall.bodyGrace", { name: displayName(), days: graceDays()! })
                          : t("app.uninstall.body", { name: displayName() })
                  }
                  testId="app-uninstall"
                >
                  <Show when={usedByApps().length > 0}>
                    <div class="ap-impact" role="note">
                      <strong>{t("app.uninstall.impactTitle")}</strong>
                      <ul>
                        <For each={usedByApps()}>
                          {(linked) => (
                            <li>
                              <a href={appPageHref(linked.capsuleId)}>{linked.name}</a>
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
                    <Show
                      when={view().uninstall.mode !== "none"}
                      fallback={
                        <Button
                          variant="danger"
                          type="button"
                          busy={starting()?.action === "uninstall_now"}
                          disabled={reviewBusy() || uninstallBusy()}
                          onClick={uninstallNow}
                        >
                          {t("app.uninstall.now")}
                        </Button>
                      }
                    >
                      <Button
                        variant="danger"
                        type="button"
                        busy={uninstallBusy()}
                        disabled={uninstallBusy() || reviewBusy()}
                        onClick={() => void uninstall()}
                      >
                        {t("app.uninstall.cta")}
                      </Button>
                    </Show>
                  </div>
                  <Show when={uninstallError()}>
                    {(message) => <p class="wa-error" role="alert">{message()}</p>}
                  </Show>
                </AppSection>
              </Show>
            </div>
          );
        }}
      </Match>
    </Switch>
  );
}
