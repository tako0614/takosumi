/**
 * The install page's one attempt (TASK-0115 Phase 3b): a thin client of the
 * install-plan coordinator.
 *
 * The page asks the coordinator, follows the `userAction` it returns and
 * answers with PATCH. Nothing here decides compatibility, modules or
 * connections. Reading the attempt named by the URL is a GET only; the
 * coordinator is advanced (reconcile) only after the person starts or
 * continues in this page view. Setting values live in this controller's
 * memory and leave it only inside the confirming answer.
 */
import { createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js";
import type {
  CreateGitInstallAttemptRequest,
  GitInstallPlan,
  GitInstallPlanConnectionRequirement,
  GitInstallPlanResponse,
  PatchGitInstallPlanRequest,
} from "takosumi-contract";
import {
  answerGitInstallAttempt,
  ControlApiError,
  createGitInstallAttempt,
  createWorkspace,
  discardGitInstallAttempt,
  getGitInstallPlan,
  gitPlanReconcileDelayMs,
  isImmutableSourceRevision,
  reconcileGitInstallPlan,
  resolveStableSourceTag,
} from "../../lib/control-api.ts";
import { randomUuid } from "../../lib/random-uuid.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import { listWorkspacesCached } from "../../lib/workspace-list.ts";
import {
  currentWorkspaceId,
  selectAvailableWorkspaceId,
  setCurrentWorkspaceId,
} from "../../lib/workspace-state.ts";
import { clearCapsuleListCache } from "../../lib/capsule-list.ts";
import { clearCurrentStateVersionCache } from "../../lib/current-state-versions.ts";
import { clearDashboardOverviewCache } from "../../lib/dashboard-overview.ts";
import { t } from "../../i18n/index.ts";
import {
  attemptBelongsHere,
  attemptCreateRequest,
  attemptProblemKey,
  awaitingResubmission,
  bindingsWith,
  continueVariables,
  deriveInstallView,
  restartRequest,
  type InstallCandidate,
  type InstallView,
  type VariableDrafts,
} from "./install-attempt.ts";

/** Delay bounds between reconcile commands; see gitPlanReconcileDelayMs. */
const RECONCILE_FLOOR_MS = 250;
const RECONCILE_CEILING_MS = 2_000;
/** About ten minutes without progress: stop following and offer Continue. */
const MAX_STALLED_ROUNDS = 300;
/** Consecutive failed reconcile commands before the page stops and says so. */
const MAX_RECONCILE_FAILURES = 3;

export type InstallMutation =
  | "start"
  | "answer"
  | "continue"
  | "discard"
  | "restart";

export interface ResolvedStoreVersion {
  readonly tag: string;
  readonly commit: string;
}

function defaultWorkspaceHandle(): string {
  const time = Date.now().toString(36).slice(-6);
  const random = Math.random().toString(36).slice(2, 8) || "new";
  return `workspace-${time}-${random}`.slice(0, 39);
}

/** A failed request whose outcome the server may still have committed. */
function outcomeUnknown(cause: unknown): boolean {
  return !(cause instanceof ControlApiError) || cause.status === 0 || cause.status >= 500;
}

function errorCode(cause: unknown): string | undefined {
  return cause instanceof ControlApiError ? cause.code : undefined;
}

/** Localized words for a failed install request. */
export function installErrorMessage(cause: unknown): string {
  if (cause instanceof ControlApiError) {
    switch (cause.code) {
      case "install_plan_generation_conflict":
      case "reconcile_in_progress":
      case "install_plan_not_awaiting_input":
        return t("installStore.error.changed");
      case "install_attempt_invalid":
        return t(attemptProblemKey(cause.reason));
      case "install_inputs_incomplete":
        return cause.reason === "capsule_name_conflict"
          ? t("installStore.problem.nameTaken")
          : t("installStore.error.connectionsMissing");
      case "install_inputs_resubmission_only":
        return t("installStore.problem.resubmit");
      case "install_attempt_applied":
        return t("installStore.error.alreadyInstalled");
      case "install_attempt_discard_refused":
        return t("installStore.error.discardRefused");
      case "provider_binding_invalid":
        return t("installStore.problem.connection");
      case "install_module_unavailable":
      case "install_module_required":
        return t("installStore.problem.module");
      default:
        if (
          cause.code === "invalid_request" &&
          cause.reason?.startsWith("install_variable_")
        ) {
          return t("installStore.error.settingsInvalid");
        }
    }
  }
  return friendlyError(cause, t).message;
}

export interface InstallAttemptOptions {
  readonly principalId: string;
  /** The attempt the URL names, if any. */
  readonly attemptId: () => string | undefined;
  /** Put a new attempt's id into the URL. */
  readonly onStarted: (attemptId: string) => void;
  /** Take the attempt out of the URL; the page shows the same app again. */
  readonly onLeft: (plan: GitInstallPlan) => void;
}

export function useInstallAttempt(options: InstallAttemptOptions) {
  const [response, setResponse] = createSignal<GitInstallPlanResponse>();
  const [loading, setLoading] = createSignal(false);
  const [loadFailed, setLoadFailed] = createSignal(false);
  const [driving, setDriving] = createSignal(false);
  const [mutating, setMutating] = createSignal<InstallMutation>();
  const [error, setError] = createSignal<string>();
  const [drafts, setDrafts] = createSignal<VariableDrafts>({});
  const [nameDraft, setNameDraft] = createSignal<string>();
  const [resolvedVersion, setResolvedVersion] = createSignal<ResolvedStoreVersion>();

  let disposed = false;
  /** Bumped whenever the attempt or workspace this page follows changes. */
  let epoch = 0;
  let driveRun: Promise<void> | undefined;
  let stopRequested = false;
  let wake: (() => void) | undefined;
  /** An unconfirmed start keeps its key so resending it cannot start twice. */
  let pendingStart:
    | { readonly workspaceId: string; readonly body: string; readonly key: string }
    | undefined;

  onCleanup(() => {
    disposed = true;
    stopRequested = true;
    wake?.();
  });

  const view = createMemo<InstallView>(() =>
    deriveInstallView(response(), {
      starting: mutating() === "start",
      driving: driving(),
      mutating: mutating() !== undefined,
      loadFailed: loadFailed(),
      drafts: drafts(),
      name: nameDraft(),
    }),
  );

  const clearCaches = (workspaceId: string) => {
    clearCapsuleListCache(workspaceId);
    clearCurrentStateVersionCache(workspaceId);
    clearDashboardOverviewCache(workspaceId);
  };

  const forgetInputs = () => {
    setDrafts({});
    setNameDraft(undefined);
  };

  /** Accept a coordinator answer only for the attempt this page follows. */
  const accept = (next: GitInstallPlanResponse, expectedEpoch: number): boolean => {
    if (disposed || expectedEpoch !== epoch) return false;
    const held = response();
    const attemptId = held?.installPlan.id ?? untrack(options.attemptId);
    if (
      !attemptId ||
      !attemptBelongsHere(next, {
        attemptId,
        workspaceId: currentWorkspaceId(),
        principalId: options.principalId,
      })
    ) {
      return false;
    }
    if (next.installPlan.capsuleId && !held?.installPlan.capsuleId) {
      clearCaches(next.installPlan.workspaceId);
    }
    setResponse(next);
    setLoadFailed(false);
    return true;
  };

  // The URL names the attempt; reading it never advances or answers it.
  createEffect(
    on([options.attemptId, currentWorkspaceId], ([attemptId, workspaceId]) => {
      const held = untrack(response);
      if (held && held.installPlan.workspaceId !== workspaceId) {
        // Never let an attempt keep writing under a workspace the person left.
        epoch += 1;
        stopRequested = true;
        wake?.();
        setResponse(undefined);
        forgetInputs();
        setError(undefined);
        options.onLeft(held.installPlan);
        return;
      }
      if (attemptId && held?.installPlan.id === attemptId) return;
      epoch += 1;
      stopRequested = true;
      wake?.();
      setResponse(undefined);
      setLoadFailed(false);
      setError(undefined);
      forgetInputs();
      if (!attemptId || !workspaceId) return;
      const expected = epoch;
      setLoading(true);
      getGitInstallPlan(attemptId)
        .then((next) => {
          if (disposed || expected !== epoch) return;
          if (!accept(next, expected)) setLoadFailed(true);
        })
        .catch(() => {
          if (!disposed && expected === epoch) setLoadFailed(true);
        })
        .finally(() => {
          if (!disposed && expected === epoch) setLoading(false);
        });
    }),
  );

  const sleep = (milliseconds: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, milliseconds);
      wake = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      };
    });

  /** Follow the coordinator while it works on its own (`wait`). */
  const drive = () => {
    const current = response();
    if (
      driveRun || disposed || !current || current.invalidated ||
      current.userAction.kind !== "wait"
    ) {
      return;
    }
    stopRequested = false;
    const expected = epoch;
    setDriving(true);
    setError(undefined);
    driveRun = (async () => {
      let stalled = 0;
      let failures = 0;
      try {
        while (!disposed && !stopRequested && expected === epoch) {
          const before = response();
          if (!before || before.invalidated || before.userAction.kind !== "wait") break;
          let next: GitInstallPlanResponse | undefined;
          try {
            next = await reconcileGitInstallPlan(before.installPlan.id);
            failures = 0;
          } catch (cause) {
            failures += 1;
            next = await getGitInstallPlan(before.installPlan.id).catch(() => undefined);
            if (
              failures >= MAX_RECONCILE_FAILURES &&
              (!next || next.userAction.kind === "wait")
            ) {
              if (next) accept(next, expected);
              if (!disposed && expected === epoch) setError(installErrorMessage(cause));
              break;
            }
          }
          if (disposed || expected !== epoch) break;
          if (next) {
            const progressed =
              next.installPlan.phase !== before.installPlan.phase ||
              next.installPlan.generation !== before.installPlan.generation;
            stalled = progressed ? 0 : stalled + 1;
            if (!accept(next, expected)) break;
            if (next.invalidated || next.userAction.kind !== "wait") break;
          } else {
            stalled += 1;
          }
          if (stalled >= MAX_STALLED_ROUNDS || stopRequested) break;
          await sleep(
            gitPlanReconcileDelayMs({
              stalledRounds: stalled,
              minDelayMs: RECONCILE_FLOOR_MS,
              maxDelayMs: RECONCILE_CEILING_MS,
              jitter: Math.random(),
            }),
          );
        }
      } finally {
        driveRun = undefined;
        wake = undefined;
        if (!disposed) setDriving(false);
      }
    })();
  };

  /** Stop following and wait until no reconcile command is in flight. */
  const stopDriving = async () => {
    stopRequested = true;
    wake?.();
    await driveRun?.catch(() => undefined);
  };

  const refresh = async (expected = epoch): Promise<GitInstallPlanResponse | undefined> => {
    const current = response();
    if (!current) return undefined;
    try {
      const next = await getGitInstallPlan(current.installPlan.id);
      return accept(next, expected) ? next : undefined;
    } catch {
      return undefined;
    }
  };

  const ensureWorkspace = async (): Promise<string> => {
    const workspaces = await listWorkspacesCached();
    const existing = selectAvailableWorkspaceId(currentWorkspaceId(), workspaces);
    if (existing) {
      if (existing !== currentWorkspaceId()) setCurrentWorkspaceId(existing);
      return existing;
    }
    const workspace = await createWorkspace({
      handle: defaultWorkspaceHandle(),
      displayName: t("workspace.defaultName"),
      type: "personal",
    });
    setCurrentWorkspaceId(workspace.id);
    window.dispatchEvent(new Event("takosumi:workspaces-changed"));
    return workspace.id;
  };

  /** POST one attempt; an unconfirmed POST is resent with the same key. */
  const postAttempt = async (
    workspaceId: string,
    request: CreateGitInstallAttemptRequest,
  ): Promise<GitInstallPlanResponse> => {
    const body = JSON.stringify(request);
    const key = pendingStart?.workspaceId === workspaceId && pendingStart.body === body
      ? pendingStart.key
      : randomUuid();
    pendingStart = { workspaceId, body, key };
    try {
      const created = await createGitInstallAttempt(workspaceId, request, key);
      pendingStart = undefined;
      return created;
    } catch (cause) {
      if (!outcomeUnknown(cause)) pendingStart = undefined;
      throw cause;
    }
  };

  const adoptNewAttempt = (created: GitInstallPlanResponse, expected: number): boolean => {
    if (disposed || expected !== epoch) return false;
    if (
      !attemptBelongsHere(created, {
        attemptId: created.installPlan.id,
        workspaceId: currentWorkspaceId(),
        principalId: options.principalId,
      })
    ) {
      setError(t("installStore.error.unavailable"));
      return false;
    }
    forgetInputs();
    setResponse(created);
    setLoadFailed(false);
    options.onStarted(created.installPlan.id);
    drive();
    return true;
  };

  /** Install: the only place an attempt begins. */
  const start = async (
    candidate: InstallCandidate,
    startOptions: { readonly fromStore: boolean },
  ): Promise<void> => {
    if (mutating() || response()) return;
    setMutating("start");
    setError(undefined);
    try {
      const workspaceId = await ensureWorkspace();
      const expected = epoch;
      if (disposed || currentWorkspaceId() !== workspaceId) return;
      let ref = candidate.ref.trim();
      if (startOptions.fromStore && !ref) {
        // A Store listing installs the newest released version unless the
        // person chose one; the exact commit read is shown afterwards.
        const resolved = await resolveStableSourceTag(workspaceId, candidate.url);
        if (!isImmutableSourceRevision(resolved.commit)) {
          throw new ControlApiError(
            502,
            "invalid_stable_source_tag_response",
            "Stable source tag resolution did not return an immutable commit.",
          );
        }
        ref = resolved.commit;
        if (expected === epoch) setResolvedVersion({ tag: resolved.tag, commit: resolved.commit });
      }
      const created = await postAttempt(workspaceId, attemptCreateRequest({ ...candidate, ref }));
      adoptNewAttempt(created, expected);
    } catch (cause) {
      if (!disposed) setError(installErrorMessage(cause));
    } finally {
      if (!disposed) setMutating(undefined);
    }
  };

  /** Continue a paused or retryable attempt: follow the coordinator again. */
  const resume = () => {
    if (mutating()) return;
    drive();
  };

  /** One PATCH; a stale or refused answer shows the attempt as it is now. */
  const answer = async (
    patch: Omit<PatchGitInstallPlanRequest, "expectedGeneration">,
    kind: "answer" | "continue",
  ): Promise<GitInstallPlanResponse | undefined> => {
    const current = response();
    if (!current || mutating()) return undefined;
    const expected = epoch;
    setMutating(kind);
    setError(undefined);
    try {
      const next = await answerGitInstallAttempt(current.installPlan.id, {
        expectedGeneration: current.installPlan.generation,
        ...patch,
      });
      return accept(next, expected) ? next : undefined;
    } catch (cause) {
      if (disposed || expected !== epoch) return undefined;
      // Whatever happened, show the attempt as the server holds it now.
      await refresh(expected);
      setError(
        outcomeUnknown(cause) && kind === "continue"
          ? t("installStore.error.continueUnconfirmed")
          : installErrorMessage(cause),
      );
      return undefined;
    } finally {
      if (!disposed) setMutating(undefined);
    }
  };

  const chooseModule = async (modulePath: string): Promise<void> => {
    const next = await answer({ modulePath }, "answer");
    if (next) drive();
  };

  const chooseConnection = async (
    requirement: GitInstallPlanConnectionRequirement,
    connectionId: string,
  ): Promise<boolean> => {
    const current = response();
    if (current?.userAction.kind !== "provide_inputs") return false;
    const next = await answer(
      { providerBindings: bindingsWith(current.userAction.connections, requirement, connectionId) },
      "answer",
    );
    return Boolean(next);
  };

  /**
   * A connection made from the sheet is chosen for its row once the
   * coordinator offers it there. A connection the install policy refuses is
   * reported, never silently left unselected.
   */
  const adoptConnection = async (
    requirement: GitInstallPlanConnectionRequirement,
    connectionId: string,
  ): Promise<"selected" | "not_offered" | "unavailable"> => {
    const fresh = await refresh();
    if (fresh?.userAction.kind !== "provide_inputs") return "unavailable";
    const row = fresh.userAction.connections.find(
      (candidate) =>
        candidate.provider === requirement.provider &&
        candidate.moduleLocalName === requirement.moduleLocalName &&
        candidate.childAlias === requirement.childAlias &&
        candidate.rootAlias === requirement.rootAlias,
    );
    if (!row?.candidates.some((candidate) => candidate.id === connectionId)) {
      return "not_offered";
    }
    if (row.selectedConnectionId === connectionId) return "selected";
    return (await chooseConnection(row, connectionId)) ? "selected" : "unavailable";
  };

  /** Rename the app before it exists (sent when the field is left). */
  const saveName = async (): Promise<void> => {
    const current = response();
    const typed = nameDraft()?.trim();
    if (current?.userAction.kind !== "provide_inputs" || typed === undefined) return;
    if (awaitingResubmission(current.userAction)) return;
    if (typed === current.userAction.name.current) {
      setNameDraft(undefined);
      return;
    }
    if (view().nameProblem === "invalid") return;
    const next = await answer({ capsuleName: typed }, "answer");
    if (next) setNameDraft(undefined);
  };

  /** 「内容を確認」: confirm the sheet; setting values leave memory only here. */
  const confirm = async (): Promise<void> => {
    const current = response();
    if (current?.userAction.kind !== "provide_inputs") return;
    const action = current.userAction;
    const values = continueVariables(action, drafts());
    if (!values.ok) {
      setError(t("installStore.error.settingsInvalid"));
      return;
    }
    const typed = nameDraft()?.trim();
    const rename = typed !== undefined && typed !== action.name.current &&
      !awaitingResubmission(action);
    const next = await answer(
      {
        continue: true,
        ...(Object.keys(values.variables).length > 0 ? { variables: values.variables } : {}),
        ...(rename ? { capsuleName: typed } : {}),
      },
      "continue",
    );
    if (!next) return;
    if (next.userAction.kind !== "provide_inputs") forgetInputs();
    else if (rename) setNameDraft(undefined);
    drive();
  };

  const discardOnce = async (
    plan: GitInstallPlan,
  ): Promise<GitInstallPlanResponse> => {
    try {
      return await discardGitInstallAttempt(plan.id, plan.generation);
    } catch (cause) {
      if (errorCode(cause) !== "install_plan_generation_conflict") throw cause;
      // It moved on while the person decided; discard what it is now.
      const latest = await getGitInstallPlan(plan.id);
      return await discardGitInstallAttempt(plan.id, latest.installPlan.generation);
    }
  };

  /** 「やめる」: throw the whole attempt away. Never alongside another request. */
  const discard = async (): Promise<boolean> => {
    const current = response();
    if (!current || mutating()) return false;
    setMutating("discard");
    setError(undefined);
    try {
      await stopDriving();
      const latest = response() ?? current;
      const discarded = latest.installPlan.phase === "discarded"
        ? latest
        : await discardOnce(latest.installPlan);
      if (disposed) return false;
      clearCaches(latest.installPlan.workspaceId);
      epoch += 1;
      setResponse(undefined);
      forgetInputs();
      setResolvedVersion(undefined);
      options.onLeft(discarded.installPlan);
      return true;
    } catch (cause) {
      if (!disposed) {
        setError(installErrorMessage(cause));
        await refresh();
      }
      return false;
    } finally {
      if (!disposed) setMutating(undefined);
    }
  };

  /** Start over: discard this attempt and read the same app again. */
  const restart = async (): Promise<boolean> => {
    const current = response();
    if (!current || mutating()) return false;
    setMutating("restart");
    setError(undefined);
    try {
      await stopDriving();
      const latest = response() ?? current;
      const discarded = latest.installPlan.phase === "discarded"
        ? latest
        : await discardOnce(latest.installPlan);
      const workspaceId = discarded.installPlan.workspaceId;
      if (disposed || currentWorkspaceId() !== workspaceId) return false;
      clearCaches(workspaceId);
      const expected = ++epoch;
      const created = await postAttempt(workspaceId, restartRequest(discarded.installPlan));
      return adoptNewAttempt(created, expected);
    } catch (cause) {
      if (!disposed) setError(installErrorMessage(cause));
      return false;
    } finally {
      if (!disposed) setMutating(undefined);
    }
  };

  const reload = async (): Promise<void> => {
    const attemptId = options.attemptId();
    if (!attemptId || mutating()) return;
    const expected = epoch;
    setLoading(true);
    setError(undefined);
    try {
      const next = await getGitInstallPlan(attemptId);
      if (!disposed && expected === epoch && !accept(next, expected)) setLoadFailed(true);
    } catch {
      if (!disposed && expected === epoch) setLoadFailed(true);
    } finally {
      if (!disposed && expected === epoch) setLoading(false);
    }
  };

  const setDraft = (name: string, value: string) =>
    setDrafts((current) => ({ ...current, [name]: { value, touched: true } }));

  return {
    response,
    view,
    loading,
    driving,
    mutating,
    error,
    setError,
    drafts,
    setDraft,
    nameDraft,
    setNameDraft,
    resolvedVersion,
    start,
    resume,
    chooseModule,
    chooseConnection,
    adoptConnection,
    saveName,
    confirm,
    discard,
    restart,
    reload,
  };
}

export type InstallAttempt = ReturnType<typeof useInstallAttempt>;
