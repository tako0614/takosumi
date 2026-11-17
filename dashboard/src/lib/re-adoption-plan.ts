/** One explicit, immutable re-adoption answer followed by its new target Plan. */
import type {
  CapsuleInstallConfigReAdoptionResponse,
  CreateCapsuleInstallConfigReAdoptionRequest,
} from "takosumi-contract";
import {
  ControlApiError,
  createCapsuleInstallConfigReAdoption,
  createReviewableGitRevisionPlan,
} from "./control-api.ts";
import { randomUuid } from "./random-uuid.ts";

/**
 * Selection is assembled from the server's target presentation, never parsed
 * from repository text by this client. Values and keys stay in page memory.
 * Each call is an explicit action; rejected/unknown calls are not retried here.
 */
export function createReAdoptionPlanSubmission(
  selection: {
    readonly capsuleId: string;
    readonly sourceId: string;
    readonly targetRef: string;
    readonly request: CreateCapsuleInstallConfigReAdoptionRequest;
  },
  isCurrent: () => boolean,
) {
  const capsuleId = selection.capsuleId;
  const sourceId = selection.sourceId;
  const targetRef = selection.targetRef;
  const request = JSON.parse(JSON.stringify(selection.request)) as CreateCapsuleInstallConfigReAdoptionRequest;
  const adoptionKey = randomUuid();
  let acknowledged: CapsuleInstallConfigReAdoptionResponse | undefined;
  let planKey: string | undefined;
  let completed: string | undefined;
  let inFlight: Promise<string> | undefined;
  const assertCurrent = () => {
    if (!isCurrent()) throw new ControlApiError(409, "re_adoption_context_changed", "Read the app's inputs again before continuing.");
  };
  const run = async (): Promise<string> => {
    assertCurrent();
    if (completed) return completed;
    if (!acknowledged) {
      const response = await createCapsuleInstallConfigReAdoption(capsuleId, request, adoptionKey);
      const receipt = response?.installConfigReAdoption;
      if (response?.capsule?.id !== capsuleId || receipt?.sourceSnapshotId !== request.sourceSnapshotId ||
        !receipt.targetInstallConfigId || response.capsule.installConfigId !== receipt.targetInstallConfigId ||
        !Number.isSafeInteger(response.capsule.currentStateGeneration) || response.capsule.currentStateGeneration < 0) {
        throw new ControlApiError(502, "invalid_re_adoption_response", "The configuration answer could not be confirmed.");
      }
      acknowledged = response;
    }
    // A different person/app/selection must never inherit a pending answer.
    assertCurrent();
    planKey ??= randomUuid();
    const result = await createReviewableGitRevisionPlan(capsuleId, { ref: targetRef }, { idempotencyKey: planKey });
    assertCurrent();
    const plan = result?.revisionPlan;
    if (result?.nextAction !== "review_run" || !plan?.planRunId || plan.capsuleId !== capsuleId || plan.sourceId !== sourceId ||
      plan.sourceSnapshotId !== request.sourceSnapshotId || plan.revision?.targetRef !== targetRef ||
      plan.revision.base?.installConfigId !== acknowledged.installConfigReAdoption.targetInstallConfigId ||
      plan.revision.base?.capsuleStateGeneration !== acknowledged.capsule.currentStateGeneration ||
      plan.revision.base?.capsuleStateVersionId !== acknowledged.capsule.currentStateVersionId) {
      throw new ControlApiError(409, "re_adoption_target_changed", "The app or target version changed. Read the inputs again.", result);
    }
    completed = plan.planRunId;
    return completed;
  };
  return {
    adoptionAcknowledged: () => acknowledged !== undefined,
    completedPlanId: () => completed,
    submit(): Promise<string> {
      if (inFlight) return inFlight;
      inFlight = run().finally(() => { inFlight = undefined; });
      return inFlight;
    },
  };
}
