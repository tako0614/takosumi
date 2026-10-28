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
  planCapsule,
  type Run,
} from "./control-api.ts";
import { initialPlanRetryReport } from "./initial-plan-retry.ts";
import { randomUuid } from "./random-uuid.ts";
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
  readonly getRun: (id: string) => Promise<Run>;
  readonly destroyPlanCapsule: (capsuleId: string) => Promise<unknown>;
  readonly planCapsule: (
    capsuleId: string,
    options: { readonly compatibilityReportId: string },
  ) => Promise<unknown>;
  /** Plans a version change to `ref`; resolves to the new Plan's id. */
  readonly planRevision: (capsuleId: string, ref: string) => Promise<string | undefined>;
  readonly planRollback: (stateVersionId: string) => Promise<unknown>;
  /** Plans the app's tracked ref as configured. */
  readonly planTracked: (capsuleId: string) => Promise<unknown>;
}

const DEFAULT_API: RetryPlanApi = {
  getRun,
  destroyPlanCapsule,
  planCapsule,
  planRevision: async (capsuleId, ref) =>
    (await createReviewableGitRevisionPlan(capsuleId, { ref }, { idempotencyKey: randomUuid() }))
      .revisionPlan.planRunId,
  planRollback: createStateVersionRollbackPlan,
  planTracked: (capsuleId) => planCapsule(capsuleId),
};

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
  api: Pick<RetryPlanApi, "getRun"> = DEFAULT_API,
): Promise<RetryChange> {
  const plan = run.type === "apply" && run.planRunId ? await api.getRun(run.planRunId) : undefined;
  return retryChangeForRun({ run, ...(plan ? { plan } : {}), capsule });
}

/** Plans the failed run's change again; resolves to the new Plan's id. */
export async function retryPlanForRun(
  run: Run,
  capsule: Capsule,
  api: RetryPlanApi = DEFAULT_API,
): Promise<string | undefined> {
  const change = await previewRetryChange(run, capsule, api);
  const capsuleId = capsule.id;
  switch (change.kind) {
    case "removal":
      return extractRunId(await api.destroyPlanCapsule(capsuleId));
    case "initial":
      return extractRunId(await api.planCapsule(capsuleId, { compatibilityReportId: change.compatibilityReportId }));
    case "revision":
      return await api.planRevision(capsuleId, change.ref);
    case "update":
      return extractRunId(await api.planTracked(capsuleId));
    case "rollback":
    case "installed":
      return extractRunId(await api.planRollback(change.stateVersionId));
  }
}

/** The default calls, for pages that override only some of them. */
export function defaultRetryPlanApi(): RetryPlanApi {
  return DEFAULT_API;
}
