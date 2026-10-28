/**
 * Plans a failed run again with the operation and source it was reviewed for.
 * Shared by the run detail page and the app page's problem card so "try
 * again" means the same thing on both.
 *
 * - A failed removal is retried as a removal.
 * - A first install keeps its exact reviewed snapshot/report pair.
 * - An installed app's change re-reads the latest source and plans an update.
 */
import {
  type Capsule,
  ControlApiError,
  destroyPlanCapsule,
  planCapsule,
  planCapsuleUpdate,
  type Run,
} from "./control-api.ts";
import { initialPlanRetryReport } from "./initial-plan-retry.ts";
import { t } from "../i18n/index.ts";

export interface RetryPlanApi {
  readonly destroyPlanCapsule: (capsuleId: string) => Promise<unknown>;
  readonly planCapsule: (
    capsuleId: string,
    options: { readonly compatibilityReportId: string },
  ) => Promise<unknown>;
  readonly planCapsuleUpdate: (capsuleId: string) => Promise<unknown>;
}

const DEFAULT_API: RetryPlanApi = {
  destroyPlanCapsule,
  planCapsule,
  planCapsuleUpdate: (capsuleId) => planCapsuleUpdate(capsuleId),
};

/**
 * Returns the new Plan's envelope. `capsule` must be a fresh read: the run's
 * own base generation decides whether it was a first install, so a later
 * Apply cannot turn a first-install retry into an update from latest source.
 */
export async function retryPlanForRun(
  run: Run,
  capsule: Capsule,
  api: RetryPlanApi = DEFAULT_API,
): Promise<unknown> {
  const capsuleId = run.capsuleId;
  if (!capsuleId || capsule.id !== capsuleId || capsule.workspaceId !== run.workspaceId) {
    throw new ControlApiError(
      409,
      "retry_plan_identity_mismatch",
      t("controlError.sourceRevisionMismatch"),
    );
  }
  const initialReport = initialPlanRetryReport(run, capsule);
  const isUpdatedPlan =
    (run.baseStateGeneration ?? 0) > 0 && capsule.currentStateGeneration > 0;
  if (run.type === "plan" && !isUpdatedPlan && !initialReport) {
    throw new ControlApiError(
      409,
      "retry_plan_review_mismatch",
      t("controlError.compatibilityStale"),
    );
  }
  if (run.type === "destroy_plan" || run.type === "destroy_apply") {
    return await api.destroyPlanCapsule(capsuleId);
  }
  if (capsule.currentStateGeneration === 0 && run.compatibilityReportId) {
    return await api.planCapsule(capsuleId, {
      compatibilityReportId: initialReport ?? run.compatibilityReportId,
    });
  }
  return await api.planCapsuleUpdate(capsuleId);
}
