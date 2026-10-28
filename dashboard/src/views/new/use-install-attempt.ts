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
  canAdvance,
  continueVariables,
  deriveInstallView,
  progressSignature,
  restartRequest,
  type InstallCandidate,
  type InstallView,
  type VariableDrafts,
} from "./install-attempt.ts";

/** Delay bounds between reconcile commands; see gitPlanReconcileDelayMs. */
const RECONCILE_FLOOR_MS = 250;
const RECONCILE_CEILING_MS = 3_000;
/** Two minutes without visible progress: stop following and offer Continue. */
const STALL_LIMIT_MS = 120_000;
/** A hard bound on reconcile commands per following session. */
const MAX_FOLLOW_ROUNDS = 240;
/** Consecutive failed or retryable reconciles before the page stops and says so. */
const MAX_RECONCILE_FAILURES = 3;
/**
 * How long a discard waits out a reconcile lease (a command the page let go
 * of may still be running on the server) before it says so: about fifteen
 * seconds in all, growing between tries. The server lease itself is longer.
 */
const DISCARD_LEASE_WAITS_MS = [1_000, 2_000, 3_000, 4_000, 5_000] as const;

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

/** How the page spends time between reconcile commands (replaceable in tests). */
export interface InstallAttemptPacing {
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
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

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

/** The server is still running a command for this attempt after the bounded wait. */
class InstallAttemptStillProcessingError extends Error {
  constructor() {
    super("The install attempt is still being processed");
    this.name = "InstallAttemptStillProcessingError";
  }
}

/**
 * Discard one attempt. A newer generation (it moved on while the person
 * decided) is read again; a reconcile lease still held by an abandoned
 * command is waited out for a bounded time, after which the person is told
 * it is still processing. Anything else is refused as it came.
 */
export async function discardInstallAttempt(
  planId: string,
  generation: number,
  pause: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<GitInstallPlanResponse> {
  let expected = generation;
  let leaseWaits = 0;
  let conflicts = 0;
  for (;;) {
    try {
      return await discardGitInstallAttempt(planId, expected);
    } catch (cause) {
      const code = errorCode(cause);
      if (code === "reconcile_in_progress") {
        const waitMs = DISCARD_LEASE_WAITS_MS[leaseWaits];
        if (waitMs === undefined) throw new InstallAttemptStillProcessingError();
        leaseWaits += 1;
        await pause(waitMs);
      } else if (code !== "install_plan_generation_conflict" || ++conflicts > DISCARD_LEASE_WAITS_MS.length) {
        throw cause;
      }
      expected = (await getGitInstallPlan(planId)).installPlan.generation;
    }
  }
}

/** Localized words for a failed install request. */
export function installErrorMessage(cause: unknown): string {
  if (cause instanceof InstallAttemptStillProcessingError) {
    return t("installStore.error.stillProcessing");
  }
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
  readonly pacing?: InstallAttemptPacing;
}

export function useInstallAttempt(options: InstallAttemptOptions) {
  const [response, setResponse] = createSignal<GitInstallPlanResponse>();
  const [loading, setLoading] = createSignal(false);
  const [loadFailed, setLoadFailed] = createSignal(false);
  const [driving, setDriving] = createSignal(false);
  const [mutating, setMutating] = createSignal<InstallMutation>();
  const [confirming, setConfirming] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [drafts, setDrafts] = createSignal<VariableDrafts>({});
  const [nameDraft, setNameDraft] = createSignal<string>();
  const [resolvedVersion, setResolvedVersion] = createSignal<ResolvedStoreVersion>();

  const now = options.pacing?.now ?? (() => Date.now());
  const wait = options.pacing?.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  let disposed = false;
  /** Bumped whenever the attempt or workspace this page follows changes. */
  let epoch = 0;
  let driveRun: Promise<void> | undefined;
  let driveAbort: AbortController | undefined;
  let stopRequested = false;
  let wake: (() => void) | undefined;
  /** The sheet answer in flight, so Review can wait for it instead of failing. */
  let answerRun: Promise<unknown> | undefined;
  /** An unconfirmed start keeps its key so resending it cannot start twice. */
  let pendingStart:
    | { readonly workspaceId: string; readonly body: string; readonly key: string }
    | undefined;

  /** Stop following now: wake the pause and abort the reconcile in flight. */
  const halt = () => {
    stopRequested = true;
    driveAbort?.abort();
    wake?.();
  };

  onCleanup(() => {
    disposed = true;
    halt();
  });

  /** The URL names an attempt that has not been read (or refused) yet. */
  const awaitingLoad = () =>
    Boolean(options.attemptId()) && !response() && !loadFailed();

  const view = createMemo<InstallView>(() => {
    const current = mutating();
    return deriveInstallView(response(), {
      starting: current === "start",
      driving: driving(),
      mutating: current !== undefined && current !== "answer",
      answering: current === "answer",
      loading: awaitingLoad(),
      loadFailed: loadFailed(),
      drafts: drafts(),
      name: nameDraft(),
    });
  });

  const clearCaches = (workspaceId: string) => {
    clearCapsuleListCache(workspaceId);
    clearCurrentStateVersionCache(workspaceId);
    clearDashboardOverviewCache(workspaceId);
  };

  const forgetInputs = () => {
    setDrafts({});
    setNameDraft(undefined);
  };

  /**
   * Accept a coordinator answer only for the attempt this page follows.
   * Returns the response the page now holds: an answer older than the one
   * held (a slow read overtaken by a newer answer) is ignored.
   */
  const accept = (
    next: GitInstallPlanResponse,
    expectedEpoch: number,
  ): GitInstallPlanResponse | undefined => {
    if (disposed || expectedEpoch !== epoch) return undefined;
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
      return undefined;
    }
    if (held && next.installPlan.generation < held.installPlan.generation) return held;
    if (next.installPlan.capsuleId && !held?.installPlan.capsuleId) {
      clearCaches(next.installPlan.workspaceId);
    }
    // Once the sheet is behind it (confirmed, even when the confirmation's
    // own answer was lost), typed values have no reason to stay in memory.
    if (next.userAction.kind !== "provide_inputs") forgetInputs();
    setResponse(next);
    setLoadFailed(false);
    return next;
  };

  /**
   * The workspace an attempt in the URL is read in. Until the shell has
   * chosen one, it is resolved here from the person's workspaces (choosing
   * it runs the read); with none to choose, the page says so instead of
   * loading forever.
   */
  const resolveWorkspace = (expected: number): void => {
    void listWorkspacesCached()
      .then((workspaces) => {
        if (disposed || expected !== epoch) return;
        const resolved = selectAvailableWorkspaceId(untrack(currentWorkspaceId), workspaces);
        if (resolved) {
          setCurrentWorkspaceId(resolved);
          return;
        }
        setError(t("installStore.error.noWorkspace"));
        setLoadFailed(true);
      })
      .catch(() => {
        if (!disposed && expected === epoch) setLoadFailed(true);
      });
  };

  // The URL names the attempt; reading it never advances or answers it.
  createEffect(
    on([options.attemptId, currentWorkspaceId], ([attemptId, workspaceId]) => {
      const held = untrack(response);
      if (held && held.installPlan.workspaceId !== workspaceId) {
        // Never let an attempt keep writing under a workspace the person left.
        epoch += 1;
        halt();
        setResponse(undefined);
        forgetInputs();
        setError(undefined);
        options.onLeft(held.installPlan);
        return;
      }
      if (attemptId && held?.installPlan.id === attemptId) return;
      epoch += 1;
      halt();
      setResponse(undefined);
      setLoadFailed(false);
      setError(undefined);
      forgetInputs();
      if (!attemptId) return;
      const expected = epoch;
      if (!workspaceId) {
        resolveWorkspace(expected);
        return;
      }
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

  /** A pause between reconcile commands that Stop can cut short. */
  const pause = (milliseconds: number) =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        wake = undefined;
        resolve();
      };
      wake = finish;
      void wait(milliseconds).then(finish, finish);
    });

  /**
   * Follow the coordinator while it works on its own (`wait`), or try a step
   * again (`retry` without `restart`). Progress is a visible change of phase,
   * action or evidence — never the generation alone, which every claim
   * bumps. Without progress the pause grows to the ceiling, and after the
   * stall limit (or the round bound) the page stops and offers Continue.
   */
  const drive = () => {
    const current = response();
    if (driveRun || disposed || !current || !canAdvance(current)) return;
    stopRequested = false;
    const expected = epoch;
    const controller = new AbortController();
    driveAbort = controller;
    setDriving(true);
    setError(undefined);
    driveRun = (async () => {
      let stalled = 0;
      let failures = 0;
      let rounds = 0;
      let lastProgressAt = now();
      try {
        while (!disposed && !stopRequested && expected === epoch) {
          const before = response();
          if (!before || !canAdvance(before)) break;
          if (rounds >= MAX_FOLLOW_ROUNDS || now() - lastProgressAt >= STALL_LIMIT_MS) break;
          rounds += 1;
          let next: GitInstallPlanResponse | undefined;
          let failed: unknown;
          try {
            next = await reconcileGitInstallPlan(before.installPlan.id, { signal: controller.signal });
          } catch (cause) {
            if (controller.signal.aborted || isAbort(cause)) break;
            failed = cause;
            next = await getGitInstallPlan(before.installPlan.id).catch(() => undefined);
          }
          if (disposed || expected !== epoch) break;
          const held = next ? accept(next, expected) : response();
          if (next && !held) break;
          const after = held ?? before;
          const progressed = progressSignature(after) !== progressSignature(before);
          if (progressed) {
            stalled = 0;
            lastProgressAt = now();
          } else {
            stalled += 1;
          }
          const retryable = after.userAction.kind === "retry" && !after.userAction.restart;
          failures = failed !== undefined || retryable ? failures + 1 : 0;
          if (failures >= MAX_RECONCILE_FAILURES) {
            if (failed !== undefined) setError(installErrorMessage(failed));
            break;
          }
          if (stopRequested || !canAdvance(after)) break;
          await pause(
            gitPlanReconcileDelayMs({
              stalledRounds: Math.max(stalled, failures),
              minDelayMs: RECONCILE_FLOOR_MS,
              maxDelayMs: RECONCILE_CEILING_MS,
              jitter: Math.random(),
            }),
          );
        }
      } finally {
        driveRun = undefined;
        if (driveAbort === controller) driveAbort = undefined;
        wake = undefined;
        if (!disposed) setDriving(false);
      }
    })();
  };

  /** Stop following and wait until no reconcile command is in flight. */
  const stopDriving = async () => {
    halt();
    await driveRun?.catch(() => undefined);
  };

  const refresh = async (expected = epoch): Promise<GitInstallPlanResponse | undefined> => {
    const current = response();
    if (!current) return undefined;
    try {
      return accept(await getGitInstallPlan(current.installPlan.id), expected);
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
    // An attempt the URL already names (even one still loading) is the one
    // this page follows; Install never starts a second beside it.
    if (mutating() || response() || untrack(options.attemptId)) return;
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

  /** Continue a paused attempt or try a step again: follow the coordinator. */
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
    const run = (async () => {
      try {
        const next = await answerGitInstallAttempt(current.installPlan.id, {
          expectedGeneration: current.installPlan.generation,
          ...patch,
        });
        return accept(next, expected);
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
    })();
    if (kind === "answer") answerRun = run;
    try {
      return await run;
    } finally {
      if (answerRun === run) answerRun = undefined;
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
    // A name typed while this rename was in flight is kept for the next one.
    if (next && nameDraft()?.trim() === typed) setNameDraft(undefined);
  };

  /**
   * 「内容を確認」: confirm the sheet; setting values leave memory only here.
   * A sheet answer still in flight (leaving the name field starts one) is
   * waited for first, so the click is never lost.
   */
  const confirm = async (): Promise<void> => {
    if (confirming()) return;
    setConfirming(true);
    try {
      while (answerRun) await answerRun.catch(() => undefined);
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
      if (rename && next.userAction.kind === "provide_inputs" && nameDraft()?.trim() === typed) {
        setNameDraft(undefined);
      }
      drive();
    } finally {
      if (!disposed) setConfirming(false);
    }
  };

  /** 「やめる」: throw the whole attempt away. Never alongside another request. */
  const discard = async (): Promise<boolean> => {
    const current = response();
    if (!current || mutating()) return false;
    setMutating("discard");
    setError(undefined);
    try {
      // A reconcile in flight is aborted rather than awaited; the discard then
      // reads the generation it left behind (and waits out its lease).
      await stopDriving();
      const latest = response() ?? current;
      const discarded = latest.installPlan.phase === "discarded"
        ? latest
        : await discardInstallAttempt(latest.installPlan.id, latest.installPlan.generation, wait);
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
        : await discardInstallAttempt(latest.installPlan.id, latest.installPlan.generation, wait);
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
    setError(undefined);
    if (!currentWorkspaceId()) {
      setLoadFailed(false);
      resolveWorkspace(expected);
      return;
    }
    setLoading(true);
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
    confirming,
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
