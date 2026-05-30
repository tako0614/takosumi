import type {
  RuntimeDesiredState,
  RuntimeDesiredStateStore,
  RuntimeObservedStateStore,
} from "../domains/runtime/mod.ts";
import type {
  AssessProviderInput,
  PackageConformanceIssue,
  PackageConformanceResult,
} from "../services/conformance/mod.ts";
import type {
  ProviderOperationServiceExecuteInput,
  ProviderOperationServiceExecuteResult,
} from "../services/provider-operations/mod.ts";
import {
  createDomainEvent,
  type DomainEvent,
  type OutboxStore,
} from "../shared/events.ts";

export interface RepairProviderAssessor {
  assessProvider(
    input: AssessProviderInput,
  ): Promise<PackageConformanceResult>;
}

export interface RepairProviderOperationExecutor {
  execute(
    input: ProviderOperationServiceExecuteInput,
  ): Promise<ProviderOperationServiceExecuteResult>;
}

export interface RepairWorkerOptions {
  readonly desiredStates: RuntimeDesiredStateStore;
  readonly observedStates?: RuntimeObservedStateStore;
  readonly outboxStore?: OutboxStore;
  readonly providerAssessor?: RepairProviderAssessor;
  readonly providerOperations?:
    | ReadonlyMap<
      string,
      RepairProviderOperationExecutor
    >
    | Record<string, RepairProviderOperationExecutor>;
}

export interface RepairGroupInput {
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId?: string;
  readonly reason?: string;
}

export interface RepairWorkerResult {
  readonly desiredStateCount: number;
  readonly latestActivationId?: string;
  readonly observedActivationId?: string;
  readonly event: DomainEvent;
}

export interface RepairRematerializeInput extends RepairGroupInput {
  readonly providerRef: string;
  readonly providerId?: string;
  readonly requirements?: AssessProviderInput["requirements"];
  readonly idempotencyKey?: string;
  readonly credentialRefs?: readonly string[];
  readonly actorId?: string;
  readonly requestId?: string;
}

export type RepairPlanStatus =
  | "blocked"
  | "rematerialized"
  | "failed";

export interface RepairPlan {
  readonly kind: "repair-plan";
  readonly status: RepairPlanStatus;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId?: string;
  readonly desiredStateId?: string;
  readonly providerRef: string;
  readonly providerId: string;
  readonly trustStatus?:
    | PackageConformanceResult["trustStatus"]
    | "not-assessed";
  readonly conformanceTier?: PackageConformanceResult["conformanceTier"];
  readonly reason?: string;
  readonly issues: readonly RepairPlanIssue[];
  readonly idempotencyKey?: string;
}

export interface RepairPlanIssue {
  readonly code: string;
  readonly message: string;
  readonly severity: PackageConformanceIssue["severity"] | "blocked";
}

export interface RepairRematerializeResult {
  readonly plan: RepairPlan;
  readonly operation?: ProviderOperationServiceExecuteResult;
  readonly event: DomainEvent;
}

export class RepairWorker {
  readonly #desiredStates: RuntimeDesiredStateStore;
  readonly #observedStates?: RuntimeObservedStateStore;
  readonly #outboxStore?: OutboxStore;
  readonly #providerAssessor?: RepairProviderAssessor;
  readonly #providerOperations: ReadonlyMap<
    string,
    RepairProviderOperationExecutor
  >;

  constructor(options: RepairWorkerOptions) {
    this.#desiredStates = options.desiredStates;
    this.#observedStates = options.observedStates;
    this.#outboxStore = options.outboxStore;
    this.#providerAssessor = options.providerAssessor;
    this.#providerOperations = providerOperationMap(options.providerOperations);
  }

  async inspectGroup(input: RepairGroupInput): Promise<RepairWorkerResult> {
    const { desiredStates, latestDesired } = await this.#selectDesired(input);
    const observed = await this.#observedStates?.latestForGroup(
      input.spaceId,
      input.groupId,
    );
    const event = createDomainEvent({
      type: "runtime.repair.inspected",
      aggregateType: "runtime.group",
      aggregateId: `${input.spaceId}:${input.groupId}`,
      payload: {
        spaceId: input.spaceId,
        groupId: input.groupId,
        requestedActivationId: input.activationId,
        latestActivationId: latestDesired?.activationId,
        observedActivationId: observed?.activationId,
        desiredStateCount: desiredStates.length,
        reason: input.reason,
      },
    });
    await this.#outboxStore?.append(event);
    return {
      desiredStateCount: desiredStates.length,
      latestActivationId: latestDesired?.activationId,
      observedActivationId: observed?.activationId,
      event,
    };
  }

  async rematerializeWithTrustedPackage(
    input: RepairRematerializeInput,
  ): Promise<RepairRematerializeResult> {
    if (!this.#providerAssessor) {
      throw new TypeError(
        "providerAssessor is required to build a trusted repair plan",
      );
    }
    const providerId = input.providerId ?? input.providerRef;
    const { latestDesired } = await this.#selectDesired(input);
    if (!latestDesired) {
      return await this.#blockedRepair({
        input,
        providerId,
        reason: "desired-state-missing",
        issues: [{
          code: "desired-state-missing",
          severity: "blocked",
          message: "No RuntimeDesiredState is available for repair",
        }],
      });
    }

    const conformance = await this.#providerAssessor.assessProvider({
      providerRef: input.providerRef,
      requirements: input.requirements,
    });
    if (!conformance.accepted) {
      return await this.#blockedRepair({
        input,
        providerId,
        desiredState: latestDesired,
        conformance,
        reason: "package-conformance-blocked",
        issues: conformance.issues.map(toRepairPlanIssue),
      });
    }

    const executor = this.#providerOperations.get(providerId);
    if (!executor) {
      return await this.#blockedRepair({
        input,
        providerId,
        desiredState: latestDesired,
        conformance,
        reason: "provider-operation-missing",
        issues: [{
          code: "provider-operation-missing",
          severity: "blocked",
          message:
            `No provider operation executor is configured for ${providerId}`,
        }],
      });
    }

    const idempotencyKey = input.idempotencyKey ??
      defaultRepairIdempotencyKey(input, providerId, latestDesired);
    const operation = await executor.execute({
      desiredState: latestDesired,
      idempotencyKey,
      credentialRefs: input.credentialRefs,
      actorId: input.actorId ?? "worker/repair",
      requestId: input.requestId,
    });
    const plan: RepairPlan = {
      kind: "repair-plan",
      status: operation.status.status === "succeeded"
        ? "rematerialized"
        : "failed",
      spaceId: input.spaceId,
      groupId: input.groupId,
      activationId: latestDesired.activationId,
      desiredStateId: latestDesired.id,
      providerRef: input.providerRef,
      providerId,
      trustStatus: conformance.trustStatus,
      conformanceTier: conformance.conformanceTier,
      issues: [],
      idempotencyKey,
    };
    const event = await this.#appendRepairEvent(
      operation.status.status === "succeeded"
        ? "runtime.repair.rematerialized"
        : "runtime.repair.failed",
      plan,
      {
        materializationStatus: operation.status.status,
        materializationPlanId: operation.status.materializationPlanId,
        failureReason: operation.status.failureReason,
      },
    );
    return { plan, operation, event };
  }

  async #selectDesired(input: RepairGroupInput): Promise<{
    readonly desiredStates: readonly RuntimeDesiredState[];
    readonly latestDesired?: RuntimeDesiredState;
  }> {
    const desiredStates = await this.#desiredStates.listByGroup(
      input.spaceId,
      input.groupId,
    );
    const latestDesired = input.activationId
      ? desiredStates.find((state) => state.activationId === input.activationId)
      : [...desiredStates].sort((a, b) =>
        b.materializedAt.localeCompare(a.materializedAt)
      )[0];
    return { desiredStates, latestDesired };
  }

  async #blockedRepair(input: {
    readonly input: RepairRematerializeInput;
    readonly providerId: string;
    readonly reason: string;
    readonly issues: readonly RepairPlanIssue[];
    readonly desiredState?: RuntimeDesiredState;
    readonly conformance?: PackageConformanceResult;
  }): Promise<RepairRematerializeResult> {
    const plan: RepairPlan = {
      kind: "repair-plan",
      status: "blocked",
      spaceId: input.input.spaceId,
      groupId: input.input.groupId,
      activationId: input.desiredState?.activationId ??
        input.input.activationId,
      desiredStateId: input.desiredState?.id,
      providerRef: input.input.providerRef,
      providerId: input.providerId,
      trustStatus: input.conformance?.trustStatus ?? "not-assessed",
      conformanceTier: input.conformance?.conformanceTier,
      reason: input.reason,
      issues: input.issues,
    };
    const event = await this.#appendRepairEvent("runtime.repair.blocked", plan);
    return { plan, event };
  }

  async #appendRepairEvent(
    type: string,
    plan: RepairPlan,
    extra: Record<string, unknown> = {},
  ): Promise<DomainEvent> {
    const event = createDomainEvent({
      type,
      aggregateType: "runtime.group",
      aggregateId: `${plan.spaceId}:${plan.groupId}`,
      payload: {
        ...extra,
        plan,
      },
    });
    await this.#outboxStore?.append(event);
    return event;
  }
}

function providerOperationMap(
  value:
    | RepairWorkerOptions["providerOperations"]
    | undefined,
): ReadonlyMap<string, RepairProviderOperationExecutor> {
  if (!value) return new Map();
  if (value instanceof Map) return value;
  return new Map(Object.entries(value));
}

function toRepairPlanIssue(
  issue: PackageConformanceIssue,
): RepairPlanIssue {
  return {
    code: issue.code,
    message: issue.message,
    severity: issue.severity,
  };
}

function defaultRepairIdempotencyKey(
  input: RepairRematerializeInput,
  providerId: string,
  desiredState: RuntimeDesiredState,
): string {
  return [
    "repair",
    input.spaceId,
    input.groupId,
    input.activationId ?? desiredState.activationId,
    providerId,
    desiredState.id,
  ].join(":");
}
