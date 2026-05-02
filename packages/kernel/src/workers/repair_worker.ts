import type {
  RuntimeDesiredStateStore,
  RuntimeObservedStateStore,
} from "../domains/runtime/mod.ts";
import {
  createDomainEvent,
  type DomainEvent,
  type OutboxStore,
} from "../shared/events.ts";

export interface RepairWorkerOptions {
  readonly desiredStates: RuntimeDesiredStateStore;
  readonly observedStates?: RuntimeObservedStateStore;
  readonly outboxStore?: OutboxStore;
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

export class RepairWorker {
  readonly #desiredStates: RuntimeDesiredStateStore;
  readonly #observedStates?: RuntimeObservedStateStore;
  readonly #outboxStore?: OutboxStore;

  constructor(options: RepairWorkerOptions) {
    this.#desiredStates = options.desiredStates;
    this.#observedStates = options.observedStates;
    this.#outboxStore = options.outboxStore;
  }

  async inspectGroup(input: RepairGroupInput): Promise<RepairWorkerResult> {
    const desiredStates = await this.#desiredStates.listByGroup(
      input.spaceId,
      input.groupId,
    );
    const latestDesired = input.activationId
      ? desiredStates.find((state) => state.activationId === input.activationId)
      : [...desiredStates].sort((a, b) =>
        b.materializedAt.localeCompare(a.materializedAt)
      )[0];
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
}
