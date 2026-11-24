/**
 * Plans a failed run again as the same change it was made for. Shared by the
 * run detail page and the app page so "try again" means the same thing on
 * both.
 *
 * - A failed removal is retried as a removal.
 * - A first install keeps its exact reviewed snapshot/report pair.
 * - An installed app's failed change repeats the flow the plan records as its
 *   origin: a version change plans that ref again, a rollback goes back to the
 *   same StateVersion, a Workspace update plans the tracked ref again. A
 *   configuration change is planned again on the installed version with the
 *   current configuration (the configuration flow already made it current).
 *   A plan that records no origin gets the same re-plan of the installed
 *   version, which the page labels as such rather than as a retry of the
 *   failed change. An installed app is never re-planned from the Source's
 *   default ref.
 */
import {
  type Capsule,
  ControlApiError,
  createReviewableGitRevisionPlan,
  createStateVersionRollbackPlan,
  destroyPlanCapsule,
  extractRunId,
  getRun,
  matchesReviewedApplyRun,
  planCapsule,
  type Run,
} from "./control-api.ts";
import { initialPlanRetryReport } from "./initial-plan-retry.ts";
import { randomUuid } from "./random-uuid.ts";
import {
  getOrCreateRevisionPlanAttempt,
  observeRevisionPlanAttempt,
  releaseObservedRevisionPlanAttempt,
  releaseRevisionPlanAttempt,
  type RevisionPlanAttemptScope,
  type RevisionPlanAttemptStore,
} from "./revision-plan-attempt.ts";
import { runMutationOutcomeUnknown } from "./run-errors.ts";
import { t } from "../i18n/index.ts";

/** The change "try again" plans for a failed run. */
export type RetryChange =
  | { readonly kind: "removal" }
  | { readonly kind: "initial"; readonly compatibilityReportId: string }
  | { readonly kind: "revision"; readonly ref: string }
  | { readonly kind: "rollback"; readonly stateVersionId: string }
  /** Plan the tracked ref again as configured (a Workspace update). */
  | { readonly kind: "update" }
  /**
   * Plan the installed version again with the current configuration.
   * `recorded` is false when the failed plan recorded no origin, so this is
   * not a retry of that change.
   */
  | { readonly kind: "installed"; readonly stateVersionId: string; readonly recorded: boolean };

export interface RetryPlanApi {
  readonly getRun: typeof getRun;
  readonly destroyPlanCapsule: (capsuleId: string) => Promise<unknown>;
  readonly planCapsule: (
    capsuleId: string,
    options: { readonly compatibilityReportId: string },
  ) => Promise<unknown>;
  /** Plans a version change to `ref`; resolves to the new Plan's id. */
  readonly planRevision: (capsuleId: string, ref: string, isCurrent?: () => boolean) => Promise<string | undefined>;
  readonly planRollback: (
    stateVersionId: string,
    isCurrent?: () => boolean,
    currentStateVersionId?: string,
  ) => Promise<unknown>;
  /** Plans the app's tracked ref as configured. */
  readonly planTracked: (capsuleId: string) => Promise<unknown>;
}

const STANDARD_REQUESTS = {
  getRun,
  destroyPlanCapsule,
  planCapsule,
  planTracked: (capsuleId) => planCapsule(capsuleId),
} satisfies Omit<RetryPlanApi, "planRevision" | "planRollback">;

function isRemoval(type: Run["type"]): boolean {
  return type === "destroy_plan" || type === "destroy_apply";
}

/**
 * Decides the change to plan. `plan` is the failed run's own Plan (the run
 * itself when it is a plan); `capsule` must be a fresh read: the run's base
 * generation decides whether it was a first install, so a later Apply cannot
 * turn a first-install retry into something else.
 */
export function retryChangeForRun(input: {
  readonly run: Run;
  readonly plan?: Run;
  readonly capsule: Capsule;
}): RetryChange {
  const { run, plan, capsule } = input;
  if (!run.capsuleId || capsule.id !== run.capsuleId || capsule.workspaceId !== run.workspaceId) {
    throw new ControlApiError(409, "retry_plan_identity_mismatch", t("controlError.sourceRevisionMismatch"));
  }
  if (runMutationOutcomeUnknown(run)) {
    throw new ControlApiError(409, "runner_mutation_indeterminate", t("runError.mutationIndeterminate"));
  }
  if (isRemoval(run.type)) return { kind: "removal" };
  const initialReport = initialPlanRetryReport(run, capsule);
  const isUpdatedPlan = (run.baseStateGeneration ?? 0) > 0 && capsule.currentStateGeneration > 0;
  if (run.type === "plan" && !isUpdatedPlan && !initialReport) {
    throw new ControlApiError(409, "retry_plan_review_mismatch", t("controlError.compatibilityStale"));
  }
  if (capsule.currentStateGeneration === 0) {
    const reportId = initialReport ?? run.compatibilityReportId;
    if (!reportId) {
      throw new ControlApiError(409, "retry_plan_review_mismatch", t("controlError.compatibilityStale"));
    }
    return { kind: "initial", compatibilityReportId: reportId };
  }
  const origin = (plan ?? (run.type === "plan" ? run : undefined))?.origin;
  if (origin?.kind === "revision") return { kind: "revision", ref: origin.ref };
  if (origin?.kind === "rollback") return { kind: "rollback", stateVersionId: origin.stateVersionId };
  if (origin?.kind === "update") return { kind: "update" };
  const installed = capsule.currentStateVersionId;
  if (!installed) {
    throw new ControlApiError(409, "retry_plan_unavailable", t("app.review.notStarted"));
  }
  return { kind: "installed", stateVersionId: installed, recorded: origin?.kind === "configuration" };
}

/** Reads what "try again" would plan for a failed run, without planning. */
export async function previewRetryChange(
  run: Run,
  capsule: Capsule,
  api: Pick<RetryPlanApi, "getRun"> = STANDARD_REQUESTS,
  isCurrent?: () => boolean,
): Promise<RetryChange> {
  const planId = run.type === "apply" ? run.planRunId : undefined;
  if (!planId) return retryChangeForRun({ run, capsule });
  const plan = await api.getRun(planId, isCurrent ? { isCurrent } : {});
  if (!plan || !matchesReviewedApplyRun(plan, run)) {
    throw new ControlApiError(409, "retry_plan_identity_mismatch", t("controlError.sourceRevisionMismatch"));
  }
  return retryChangeForRun({ run, plan, capsule });
}

/** Plans the failed run's change again; resolves to the new Plan's id. */
export async function retryPlanForRun(
  run: Run,
  capsule: Capsule,
  api: RetryPlanApi,
  isCurrent?: () => boolean,
): Promise<string | undefined> {
  const change = await previewRetryChange(run, capsule, api, isCurrent);
  if (isCurrent && !isCurrent()) return undefined;
  const capsuleId = capsule.id;
  switch (change.kind) {
    case "removal":
      return extractRunId(await api.destroyPlanCapsule(capsuleId));
    case "initial":
      return extractRunId(await api.planCapsule(capsuleId, { compatibilityReportId: change.compatibilityReportId }));
    case "revision":
      return await api.planRevision(capsuleId, change.ref, isCurrent);
    case "update":
      return extractRunId(await api.planTracked(capsuleId));
    case "rollback":
    case "installed":
      return extractRunId(await api.planRollback(change.stateVersionId, isCurrent, capsule.currentStateVersionId));
  }
}

type RollbackViewScope = readonly [subject: string, accountId: string, viewId: string];

function rollbackAttemptStorage(scope: string | undefined): Storage | undefined {
  if (!scope) return;
  try {
    return window.sessionStorage;
  } catch {
    // A browser may disable storage. The in-memory attempt still works.
    return;
  }
}

/** Build one set of retry calls for the lifetime of the current review screen. */
export function defaultRetryPlanApi(
  attempts: RevisionPlanAttemptStore = new Map(),
  rollbackAttempts: Map<string, string> = new Map(),
  rollbackViewScope?: () => RollbackViewScope | undefined,
  revisionViewScope?: (capsuleId: string) => RevisionPlanAttemptScope | undefined,
): RetryPlanApi {
  return {
    ...STANDARD_REQUESTS,
    planRollback: async (stateVersionId, isCurrent, currentStateVersionId) => {
      if (isCurrent && !isCurrent()) return;
      const viewScope = rollbackViewScope?.();
      const scope = viewScope && currentStateVersionId
        ? `takosumi.rollback-attempt:${JSON.stringify([...viewScope, currentStateVersionId, stateVersionId])}`
        : undefined;
      const attemptId = scope ?? stateVersionId;
      const storage = rollbackAttemptStorage(scope);
      let idempotencyKey = rollbackAttempts.get(attemptId);
      if (idempotencyKey === undefined && scope && storage) {
        try {
          const stored = storage.getItem(scope);
          if (stored && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(stored)) idempotencyKey = stored;
        } catch {
          // Keep the attempt in memory when storage is unavailable.
        }
      }
      idempotencyKey ??= randomUuid();
      rollbackAttempts.set(attemptId, idempotencyKey);
      if (scope && storage) {
        try {
          storage.setItem(scope, idempotencyKey);
        } catch {
          // Keep the attempt in memory when storage is full or unavailable.
        }
      }
      const release = () => {
        if (rollbackAttempts.get(attemptId) === idempotencyKey) rollbackAttempts.delete(attemptId);
        if (!scope || !storage) return;
        try {
          if (storage.getItem(scope) === idempotencyKey) storage.removeItem(scope);
        } catch {
          // The browser controls storage availability.
        }
      };
      try {
        const result = await createStateVersionRollbackPlan(stateVersionId, { idempotencyKey, isCurrent });
        if (isCurrent && !isCurrent()) return;
        if (extractRunId(result)) release();
        return result;
      } catch (cause) {
        // A definitive preparation conflict cannot be resolved with the same key.
        if (cause instanceof ControlApiError && cause.status === 409 &&
          (cause.body as { error?: { details?: { reason?: string } } } | undefined)?.error?.details?.reason ===
            "rollback_plan_preparation_conflict") {
          release();
        }
        throw cause;
      }
    },
    planRevision: async (capsuleId, ref, isCurrent) => {
      if (isCurrent && !isCurrent()) return;
      const request = { ref };
      const requestJson = JSON.stringify(request);
      const scope = revisionViewScope?.(capsuleId);
      const attempt = getOrCreateRevisionPlanAttempt(attempts, capsuleId, requestJson, scope);
      const { revisionPlan } = await createReviewableGitRevisionPlan(capsuleId, request, {
        idempotencyKey: attempt.idempotencyKey,
        ...(isCurrent ? { isCurrent } : {}),
        onCreated: ({ revisionPlan: created }) => observeRevisionPlanAttempt(
          attempts, capsuleId, requestJson, attempt, created, scope,
        ),
        onSettled: (response) => {
          const settled = response.revisionPlan;
          if (response.nextAction === "none" && settled.phase === "failed" &&
            settled.capsuleId === capsuleId && settled.revision?.targetRef === ref) {
            releaseObservedRevisionPlanAttempt(attempts, capsuleId, requestJson, settled.id, scope);
          }
        },
      });
      if (revisionPlan.planRunId) {
        releaseRevisionPlanAttempt(attempts, capsuleId, requestJson, attempt.idempotencyKey, scope);
      }
      return revisionPlan.planRunId;
    },
  };
}
