/**
 * The install page's one attempt (TASK-0115): a thin client of the
 * install-plan coordinator behind one install screen.
 *
 * The page asks the coordinator, follows the `userAction` it returns and
 * answers with PATCH. Nothing here decides compatibility, modules or
 * connections. Reading the attempt named by the URL is a GET only; the
 * coordinator is advanced (reconcile) only after the person starts or
 * continues in this page view.
 *
 * Two decisions only: 「インストール」 starts the attempt, and the review's
 * 「許可してインストール」 applies. In between, a complete sheet is confirmed
 * on its own once the person's edits settle, which only makes a Plan
 * (nothing is created in the cloud). A change after that marks the Plan out
 * of date and prepares the install again: the attempt is discarded and a new
 * one starts with the same answers.
 *
 * Setting values live in this controller's memory and leave it only inside
 * a confirming answer; they are forgotten when the install is stopped,
 * finished or the page goes away.
 */
import { createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js";
import type {
  CreateGitInstallAttemptRequest,
  GitInstallPlan,
  GitInstallPlanConnectionRequirement,
  GitInstallPlanResponse,
  GitInstallPlanUserAction,
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
  appNameValue,
  attemptBelongsHere,
  attemptCreateRequest,
  attemptProblemKey,
  awaitingResubmission,
  bindingsWith,
  canAdvance,
  connectionKey,
  continueVariables,
  deriveInstallView,
  INSTALL_SCREEN_STAGES,
  progressSignature,
  replanRequest,
  restartRequest,
  retainedBindings,
  withConnectionOverrides,
  type ConnectionOverrides,
  type InstallCandidate,
  type InstallView,
  type VariableDrafts,
} from "./install-attempt.ts";

type ProvideInputs = Extract<GitInstallPlanUserAction, { kind: "provide_inputs" }>;

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

/**
 * How long edits must rest before the sheet is confirmed on its own, or an
 * out-of-date Plan is prepared again.
 */
const SETTLE_MS = 900;

export type InstallMutation =
  | "start"
  | "answer"
  | "continue"
  | "discard"
  | "restart"
  | "replan";

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
  /** How long edits rest before confirming or preparing again (tests shorten it). */
  readonly settleMs?: number;
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
  const [nameDraft, setNameDraftSignal] = createSignal<string>();
  /** The name field has focus with typing not yet left (Enter or blur). */
  const [nameEditing, setNameEditing] = createSignal(false);
  const [resolvedVersion, setResolvedVersion] = createSignal<ResolvedStoreVersion>();
  /** The last sheet the coordinator asked for, kept while it moves past it. */
  const [sheet, setSheet] = createSignal<ProvideInputs>();
  /** Connections chosen after the sheet went behind; the next attempt uses them. */
  const [overrides, setOverrides] = createSignal<ConnectionOverrides>({});
  /** A version typed for the next attempt (a version is read by a new attempt). */
  const [refDraft, setRefDraft] = createSignal<string>();
  /** Bumped by every edit the person makes. */
  const [editVersion, setEditVersion] = createSignal(0);
  /** The person acted in this page view; a complete sheet may be confirmed. */
  const [armed, setArmed] = createSignal(false);
  /** `editVersion` when this attempt's Plan was asked for. */
  const [planVersion, setPlanVersion] = createSignal<number>();
  /** The install is being prepared again until its new Plan (or the person) is needed. */
  const [replanning, setReplanning] = createSignal(false);
  const settleMs = options.settleMs ?? SETTLE_MS;
  /** The attempt and edit a confirmation was sent for on its own, never twice. */
  let autoSentFor: string | undefined;
  /** The edit the last preparation-again covered, never prepared twice. */
  let replannedVersion = -1;
  /** Whether this page view started the install from a Store listing. */
  let startedFromStore = false;

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

  /**
   * The Plan asked for no longer matches what the person chose: they changed
   * something after it was asked for, or chose another version.
   */
  const outdated = createMemo(() => {
    if (refDraft() !== undefined) return true;
    const asked = planVersion();
    return asked !== undefined && editVersion() > asked &&
      response()?.userAction.kind !== "provide_inputs";
  });

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
      armed: armed(),
      confirming: confirming() || current === "continue",
      outdated: outdated(),
      replanning: replanning(),
    });
  });

  /** The connection rows as the person last chose them. */
  const connectionRows = createMemo(() => {
    const retained = sheet();
    return retained ? withConnectionOverrides(retained.connections, overrides()) : [];
  });

  const clearCaches = (workspaceId: string) => {
    clearCapsuleListCache(workspaceId);
    clearCurrentStateVersionCache(workspaceId);
    clearDashboardOverviewCache(workspaceId);
  };

  const forgetInputs = () => {
    setDrafts({});
    setNameDraftSignal(undefined);
    setNameEditing(false);
  };

  /** Everything this page view kept for one install, values included. */
  const forgetSession = () => {
    forgetInputs();
    setSheet(undefined);
    setOverrides({});
    setRefDraft(undefined);
    setPlanVersion(undefined);
    setReplanning(false);
    setArmed(false);
    autoSentFor = undefined;
  };

  /** The person changed something: count it, and let the page act on it. */
  const edited = () => {
    setEditVersion((value) => value + 1);
    setArmed(true);
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
    // The sheet is kept while the coordinator moves past it, so the screen
    // keeps showing (and editing) what the person chose. A fresh sheet is
    // the coordinator's word again: no Plan was asked for from it yet.
    if (next.userAction.kind === "provide_inputs") {
      setSheet(next.userAction);
      setOverrides({});
      setPlanVersion(undefined);
    }
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
        forgetSession();
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
      forgetSession();
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

  const adoptNewAttempt = (
    created: GitInstallPlanResponse,
    expected: number,
    adoptOptions: { readonly keepAnswers?: boolean } = {},
  ): boolean => {
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
    // Preparing again keeps the person's answers (and the sheet they see)
    // for the new attempt; anything else starts from nothing.
    if (!adoptOptions.keepAnswers) forgetSession();
    setPlanVersion(undefined);
    setResponse(created);
    setLoadFailed(false);
    setArmed(true);
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
      if (adoptNewAttempt(created, expected)) startedFromStore = startOptions.fromStore;
    } catch (cause) {
      if (!disposed) setError(installErrorMessage(cause));
    } finally {
      if (!disposed) setMutating(undefined);
    }
  };

  /**
   * 「続ける」: continue a paused attempt, try a step again, or confirm a
   * complete sheet that was waiting for the person (a reopened attempt, or a
   * confirmation that did not go through).
   */
  const resume = () => {
    if (mutating()) return;
    setArmed(true);
    const current = response();
    if (current?.userAction.kind === "provide_inputs") {
      if (view().readyToConfirm) {
        autoSentFor = `${current.installPlan.id}:${editVersion()}`;
        void confirm();
      }
      return;
    }
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

  /** The repository has several apps: the person's choice, inline. */
  const chooseModule = async (modulePath: string): Promise<void> => {
    edited();
    const next = await answer({ modulePath }, "answer");
    if (next) drive();
  };

  /**
   * Choose a row's connection. While the coordinator asks for the sheet the
   * choice is its answer; once it moved past the sheet the choice is kept
   * here and the install is prepared again with it.
   */
  const chooseConnection = async (
    requirement: GitInstallPlanConnectionRequirement,
    connectionId: string,
  ): Promise<boolean> => {
    const current = response();
    if (current?.userAction.kind === "provide_inputs") {
      edited();
      const next = await answer(
        { providerBindings: bindingsWith(current.userAction.connections, requirement, connectionId) },
        "answer",
      );
      return Boolean(next);
    }
    if (!sheet() || mutating()) return false;
    setOverrides((current) => ({ ...current, [connectionKey(requirement)]: connectionId }));
    edited();
    return true;
  };

  /**
   * A connection made from the screen is chosen for its row once the
   * coordinator offers it there. A connection the install policy refuses is
   * reported, never silently left unselected. Once the coordinator moved
   * past the sheet, the new attempt it prepares checks the choice.
   */
  const adoptConnection = async (
    requirement: GitInstallPlanConnectionRequirement,
    connectionId: string,
  ): Promise<"selected" | "not_offered" | "unavailable"> => {
    if (response()?.userAction.kind !== "provide_inputs") {
      return (await chooseConnection(requirement, connectionId)) ? "selected" : "unavailable";
    }
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

  /** The name the install uses now (before any typing is left). */
  const currentName = (): string | undefined =>
    sheet()?.name.current ?? response()?.installPlan.capsule.name;

  /** Typing in the name field; it counts as a change once the field is left. */
  const setNameDraft = (value: string | undefined) => {
    setNameDraftSignal(value);
    setNameEditing(value !== undefined);
  };

  /**
   * The name field was left (blur or Enter). While the coordinator asks for
   * the sheet the new name is its answer; after that the install is
   * prepared again with it.
   */
  const saveName = async (): Promise<void> => {
    setNameEditing(false);
    const typed = nameDraft()?.trim();
    if (typed === undefined) return;
    const current = response();
    if (current?.userAction.kind === "provide_inputs" && awaitingResubmission(current.userAction)) return;
    if (typed === currentName()) {
      setNameDraftSignal(undefined);
      return;
    }
    if (!appNameValue(typed)) return;
    edited();
    if (current?.userAction.kind !== "provide_inputs") return;
    const next = await answer({ capsuleName: typed }, "answer");
    // A name typed while this rename was in flight is kept for the next one.
    if (next && nameDraft()?.trim() === typed) setNameDraftSignal(undefined);
  };

  /** A setting typed in the screen; it stays in this page's memory only. */
  const setDraft = (name: string, value: string) => {
    setDrafts((current) => ({ ...current, [name]: { value, touched: true } }));
    edited();
  };

  /**
   * Another version: it is read by a new attempt, so the install is
   * prepared again with it (empty means the default, or a Store listing's
   * newest release).
   */
  const changeVersion = (text: string) => {
    const current = response();
    if (!current || mutating()) return;
    const next = text.trim();
    const shown = refDraft() ?? current.installPlan.source.ref;
    if (next === shown || (next === "" && shown === "HEAD")) return;
    const resolved = resolvedVersion();
    if (resolved && next === resolved.tag && current.installPlan.source.ref === resolved.commit) {
      setRefDraft(undefined);
      return;
    }
    setRefDraft(next);
    edited();
  };

  /**
   * Confirm the sheet; setting values leave memory only here. A sheet answer
   * still in flight (leaving the name field starts one) is waited for first.
   * The page sends it on its own once the sheet is complete and edits
   * settle; it only makes a Plan.
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
        setArmed(false);
        return;
      }
      const typed = nameDraft()?.trim();
      const rename = typed !== undefined && typed !== action.name.current &&
        !awaitingResubmission(action);
      const version = untrack(editVersion);
      const next = await answer(
        {
          continue: true,
          ...(Object.keys(values.variables).length > 0 ? { variables: values.variables } : {}),
          ...(rename ? { capsuleName: typed } : {}),
        },
        "continue",
      );
      if (!next) {
        // Not sent again on its own: the person continues or changes something.
        setArmed(false);
        return;
      }
      if (next.userAction.kind !== "provide_inputs") setPlanVersion(version);
      if (rename && nameDraft()?.trim() === typed) setNameDraftSignal(undefined);
      drive();
    } finally {
      if (!disposed) setConfirming(false);
    }
  };

  /**
   * Prepare the install again after a change made once its Plan was asked
   * for: discard the attempt (its unapplied app goes with it) and start a
   * new one with the same repository, the person's name, version, module and
   * connections. Setting values stay here and go with the new attempt's
   * confirmation. Runs at most once per edit.
   */
  const replan = async (): Promise<boolean> => {
    const current = response();
    if (!current || mutating()) return false;
    replannedVersion = untrack(editVersion);
    setMutating("replan");
    setReplanning(true);
    setError(undefined);
    try {
      await stopDriving();
      const latest = response() ?? current;
      const plan = latest.installPlan;
      const workspaceId = plan.workspaceId;
      const retained = sheet();
      const rows = retained ? withConnectionOverrides(retained.connections, overrides()) : [];
      const typed = nameDraft()?.trim();
      const name = typed && appNameValue(typed) ? typed : (currentName() ?? plan.capsule.name);
      const refText = refDraft();
      let ref = refText ?? plan.source.ref;
      if (refText === "" && startedFromStore) {
        const resolved = await resolveStableSourceTag(workspaceId, plan.source.url);
        if (!isImmutableSourceRevision(resolved.commit)) {
          throw new ControlApiError(
            502,
            "invalid_stable_source_tag_response",
            "Stable source tag resolution did not return an immutable commit.",
          );
        }
        ref = resolved.commit;
        setResolvedVersion({ tag: resolved.tag, commit: resolved.commit });
      }
      const request = replanRequest(plan, {
        name,
        ref,
        ...(retained ? { modulePath: retained.modulePath } : {}),
        providerBindings: retained ? retainedBindings(rows) : (plan.options.providerBindings ?? []),
      });
      if (plan.phase !== "discarded") {
        await discardInstallAttempt(plan.id, plan.generation, wait);
      }
      if (disposed || currentWorkspaceId() !== workspaceId) return false;
      clearCaches(workspaceId);
      const expected = ++epoch;
      const created = await postAttempt(workspaceId, request);
      if (!adoptNewAttempt(created, expected, { keepAnswers: true })) return false;
      // The new attempt starts with these answers; until its own sheet
      // arrives the screen keeps showing them.
      if (retained) {
        setSheet({ ...retained, connections: rows, name: { ...retained.name, current: name, conflict: false } });
      }
      setOverrides({});
      if (nameDraft()?.trim() === name) setNameDraftSignal(undefined);
      if (refDraft() === refText) setRefDraft(undefined);
      return true;
    } catch (cause) {
      if (!disposed) {
        setError(installErrorMessage(cause));
        setReplanning(false);
        // The changed version is not retried on its own.
        setRefDraft(undefined);
        await refresh();
      }
      return false;
    } finally {
      if (!disposed) setMutating(undefined);
    }
  };

  // A complete sheet is confirmed on its own once edits settle, at most once
  // per attempt and edit, and only after the person acted in this page view.
  createEffect(() => {
    const current = response();
    const ready = view().readyToConfirm;
    const version = editVersion();
    if (current?.userAction.kind !== "provide_inputs" || !ready) return;
    if (!armed() || mutating() || confirming() || nameEditing() || outdated()) return;
    const key = `${current.installPlan.id}:${version}`;
    if (autoSentFor === key) return;
    const timer = setTimeout(() => {
      if (disposed || autoSentFor === key || untrack(editVersion) !== version) return;
      autoSentFor = key;
      void confirm();
    }, settleMs);
    onCleanup(() => clearTimeout(timer));
  });

  // An out-of-date Plan is prepared again once edits settle, once per edit.
  createEffect(() => {
    if (!outdated()) return;
    const stage = view().stage;
    const version = editVersion();
    if (!INSTALL_SCREEN_STAGES.has(stage) || stage === "starting") return;
    if (mutating() || confirming() || nameEditing() || version <= replannedVersion) return;
    const timer = setTimeout(() => {
      if (disposed || untrack(editVersion) !== version) return;
      void replan();
    }, settleMs);
    onCleanup(() => clearTimeout(timer));
  });

  // Preparing again ends when the new Plan is there or the person is needed.
  createEffect(() => {
    if (!replanning() || mutating()) return;
    const current = view();
    if (
      current.stage === "review" || current.stage === "choose_module" ||
      (current.stage === "provide_inputs" && !current.readyToConfirm) ||
      !INSTALL_SCREEN_STAGES.has(current.stage)
    ) {
      setReplanning(false);
    }
  });

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
      forgetSession();
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

  /** The install is done: nothing typed for it stays in memory. */
  const finish = () => {
    halt();
    forgetSession();
  };

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
    sheet,
    connectionRows,
    refDraft,
    outdated,
    replanning,
    start,
    resume,
    chooseModule,
    chooseConnection,
    adoptConnection,
    saveName,
    changeVersion,
    confirm,
    discard,
    restart,
    reload,
    finish,
  };
}

export type InstallAttempt = ReturnType<typeof useInstallAttempt>;
