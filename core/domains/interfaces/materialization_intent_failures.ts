import { stableJsonDigest } from "../../adapters/source/digest.ts";
import { log } from "../../shared/log.ts";
import type { ActivityRecorder } from "../activity/mod.ts";
import { NOOP_ACTIVITY_RECORDER } from "../activity/mod.ts";
import type { ObservabilitySink } from "../observability/mod.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";
import type {
  CapsuleInterfaceMaterializationIntent,
} from "../deploy-control/interface_materialization_intent.ts";
import type { OpenTofuControlStore } from "../deploy-control/store.ts";

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

/** Workspace-scoped, value-free projection of one ledger dead letter. */
export interface CapsuleInterfaceMaterializationFailure {
  readonly id: string;
  readonly capsuleId: string;
  readonly stateVersionId: string;
  readonly outputId: string;
  readonly stateGeneration: number;
  readonly blueprintsDigest: string;
  readonly totalItems: number;
  readonly nextItemIndex: number;
  readonly attempts: number;
  readonly error: {
    readonly code: string;
    readonly detailDigest: string;
    readonly recordedAt: string;
  };
  readonly deadLetteredAt: string;
  readonly failureDigest: string;
}

export interface RetryCapsuleInterfaceMaterializationFailureInput {
  readonly failureDigest: string;
  readonly stateVersionId: string;
  readonly stateGeneration: number;
}

export interface CapsuleInterfaceMaterializationRetryReceipt {
  readonly id: string;
  readonly capsuleId: string;
  readonly stateVersionId: string;
  readonly stateGeneration: number;
  readonly blueprintsDigest: string;
  readonly status: "pending";
  readonly nextItemIndex: number;
  readonly totalItems: number;
  readonly nextRetryAt: string;
}

export interface CapsuleInterfaceMaterializationFailureServiceOptions {
  readonly store: OpenTofuControlStore;
  readonly activity?: ActivityRecorder;
  readonly observability?: Pick<ObservabilitySink, "recordMetric">;
  readonly now?: () => string;
  readonly newId?: (prefix: string) => string;
}

/** Query/retry seam over the existing intent ledger; it owns no second DLQ. */
export class CapsuleInterfaceMaterializationFailureService {
  readonly #store: OpenTofuControlStore;
  readonly #activity: ActivityRecorder;
  readonly #observability?: Pick<ObservabilitySink, "recordMetric">;
  readonly #now: () => string;
  readonly #newId: (prefix: string) => string;

  constructor(options: CapsuleInterfaceMaterializationFailureServiceOptions) {
    this.#store = options.store;
    this.#activity = options.activity ?? NOOP_ACTIVITY_RECORDER;
    this.#observability = options.observability;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId =
      options.newId ??
      ((prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`);
  }

  async list(
    workspaceId: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly CapsuleInterfaceMaterializationFailure[]> {
    requiredText(workspaceId, "workspaceId");
    const intents =
      await this.#store.listDeadLetteredCapsuleInterfaceMaterializationIntents(
        workspaceId,
        options.limit,
      );
    return await Promise.all(intents.map(projectFailure));
  }

  async retry(
    workspaceId: string,
    id: string,
    input: RetryCapsuleInterfaceMaterializationFailureInput,
  ): Promise<CapsuleInterfaceMaterializationRetryReceipt> {
    requiredText(workspaceId, "workspaceId");
    requiredText(id, "id");
    if (!SHA256_DIGEST.test(input.failureDigest)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "failureDigest must be a sha256 digest",
      );
    }
    requiredText(input.stateVersionId, "stateVersionId");
    if (
      !Number.isSafeInteger(input.stateGeneration) ||
      input.stateGeneration < 1
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "stateGeneration must be a positive safe integer",
      );
    }
    const current =
      await this.#store.getCapsuleInterfaceMaterializationIntent(id);
    if (!current || current.workspaceId !== workspaceId) {
      throw new OpenTofuControllerError(
        "not_found",
        "Interface materialization failure not found",
      );
    }
    if (current.status !== "dead_letter") {
      throw conflict("Interface materialization failure is no longer retryable");
    }
    const projection = await projectFailure(current);
    if (
      projection.failureDigest !== input.failureDigest ||
      projection.stateVersionId !== input.stateVersionId ||
      projection.stateGeneration !== input.stateGeneration
    ) {
      throw conflict("Interface materialization failure changed before retry");
    }
    const retriedAt = requiredTimestamp(this.#now(), "now");
    const result =
      await this.#store.retryCapsuleInterfaceMaterializationIntent({
        id,
        workspaceId,
        expected: current,
        expectedStateVersionId: input.stateVersionId,
        expectedStateGeneration: input.stateGeneration,
        retriedAt,
      });
    if (result.kind === "not-found") {
      throw new OpenTofuControllerError(
        "not_found",
        "Interface materialization failure not found",
      );
    }
    if (result.kind === "conflict") {
      throw conflict("Capsule state or materialization failure changed before retry");
    }
    try {
      await this.#activity.record({
        workspaceId,
        action: "interface_materialization.retry_requested",
        targetType: "capsule_interface_materialization_intent",
        targetId: id,
        metadata: {
          capsuleId: result.intent.capsuleId,
          stateVersionId: result.intent.stateVersionId,
          stateGeneration: result.intent.stateGeneration,
          blueprintsDigest: result.intent.blueprintsDigest,
          failureDigest: projection.failureDigest,
          nextItemIndex: result.intent.nextItemIndex,
        },
      });
    } catch (error) {
      log.warn("interface_materialization.activity_record_failed", {
        action: "interface_materialization.retry_requested",
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
    await this.#recordMetric({
      workspaceId,
      name: "takosumi.interface_materialization.retry_requested",
      observedAt: retriedAt,
      tags: { error_code: projection.error.code },
    });
    return {
      id: result.intent.id,
      capsuleId: result.intent.capsuleId,
      stateVersionId: result.intent.stateVersionId,
      stateGeneration: result.intent.stateGeneration,
      blueprintsDigest: result.intent.blueprintsDigest,
      status: "pending",
      nextItemIndex: result.intent.nextItemIndex,
      totalItems: result.intent.totalItems,
      nextRetryAt: result.intent.nextRetryAt,
    };
  }

  async #recordMetric(input: {
    readonly workspaceId: string;
    readonly name: string;
    readonly observedAt: string;
    readonly tags: Record<string, string>;
  }): Promise<void> {
    if (!this.#observability) return;
    try {
      await this.#observability.recordMetric({
        id: this.#newId("metric"),
        name: input.name,
        kind: "counter",
        value: 1,
        workspaceId: input.workspaceId,
        tags: input.tags,
        observedAt: input.observedAt,
      });
    } catch (error) {
      log.warn("interface_materialization.metric_record_failed", {
        metric: input.name,
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

export async function projectFailure(
  intent: CapsuleInterfaceMaterializationIntent,
): Promise<CapsuleInterfaceMaterializationFailure> {
  if (
    intent.status !== "dead_letter" ||
    !intent.error ||
    !intent.deadLetteredAt
  ) {
    throw new TypeError("intent is not a durable dead letter");
  }
  const valueFree = {
    id: intent.id,
    capsuleId: intent.capsuleId,
    stateVersionId: intent.stateVersionId,
    outputId: intent.outputId,
    stateGeneration: intent.stateGeneration,
    blueprintsDigest: intent.blueprintsDigest,
    totalItems: intent.totalItems,
    nextItemIndex: intent.nextItemIndex,
    attempts: intent.attempts,
    error: intent.error,
    deadLetteredAt: intent.deadLetteredAt,
  };
  return {
    ...valueFree,
    failureDigest: await stableJsonDigest(valueFree),
  };
}

function conflict(message: string): OpenTofuControllerError {
  return new OpenTofuControllerError("failed_precondition", message);
}

function requiredTimestamp(value: string, field: string): string {
  requiredText(value, field);
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a timestamp`);
  }
  return value;
}

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}
