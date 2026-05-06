import type { JsonObject } from "takosumi-contract";
import type { NotificationPort } from "../../adapters/notification/mod.ts";
import type { AuditSeverity } from "../../domains/audit/mod.ts";
import {
  createDomainEvent,
  type DomainEvent,
  type OutboxStore,
} from "../../shared/events.ts";
import type { Clock, IsoTimestamp } from "../../shared/time.ts";
import { nowIso, systemClock } from "../../shared/time.ts";
import type { ObservabilitySink } from "../observability/mod.ts";
import type {
  SlaEvaluationResult,
  SlaEventPayload,
  SlaObservationInput,
  SlaObservationState,
  SlaObservationStateStore,
  SlaPublishedEvent,
  SlaScope,
  SlaState,
  SlaThreshold,
  SlaThresholdEvaluation,
  SlaThresholdStore,
  SlaTransitionEventType,
} from "./types.ts";

export const DEFAULT_SLA_WINDOW_SECONDS = 300;
export const DEFAULT_SLA_BREACH_CONSECUTIVE_WINDOWS = 2;
export const DEFAULT_SLA_RECOVERY_CONSECUTIVE_WINDOWS = 3;

export interface SlaBreachDetectionServiceOptions {
  readonly thresholds?: readonly SlaThreshold[] | SlaThresholdStore;
  readonly states?: SlaObservationStateStore;
  readonly observability?: Pick<ObservabilitySink, "appendAudit">;
  readonly outbox?: Pick<OutboxStore, "append">;
  readonly notifications?: NotificationPort;
  readonly clock?: Clock;
}

export class StaticSlaThresholdStore implements SlaThresholdStore {
  readonly #thresholds: readonly SlaThreshold[];

  constructor(thresholds: readonly SlaThreshold[] = []) {
    this.#thresholds = Object.freeze(thresholds.map(cloneThreshold));
  }

  list(): Promise<readonly SlaThreshold[]> {
    return Promise.resolve(this.#thresholds.map(cloneThreshold));
  }
}

export class InMemorySlaObservationStateStore
  implements SlaObservationStateStore {
  readonly #states = new Map<string, SlaObservationState>();

  get(key: string): Promise<SlaObservationState | undefined> {
    const state = this.#states.get(key);
    return Promise.resolve(state ? cloneState(state) : undefined);
  }

  put(state: SlaObservationState): Promise<SlaObservationState> {
    const frozen = deepFreeze(structuredClone(state) as SlaObservationState);
    this.#states.set(frozen.key, frozen);
    return Promise.resolve(cloneState(frozen));
  }

  list(): Promise<readonly SlaObservationState[]> {
    return Promise.resolve([...this.#states.values()].map(cloneState));
  }
}

export class SlaBreachDetectionService {
  readonly #thresholds: SlaThresholdStore;
  readonly #states: SlaObservationStateStore;
  readonly #observability?: Pick<ObservabilitySink, "appendAudit">;
  readonly #outbox?: Pick<OutboxStore, "append">;
  readonly #notifications?: NotificationPort;
  readonly #clock: Clock;

  constructor(options: SlaBreachDetectionServiceOptions = {}) {
    const thresholds = options.thresholds;
    this.#thresholds = thresholds === undefined
      ? new StaticSlaThresholdStore()
      : isThresholdArray(thresholds)
      ? new StaticSlaThresholdStore(thresholds)
      : thresholds;
    this.#states = options.states ?? new InMemorySlaObservationStateStore();
    this.#observability = options.observability;
    this.#outbox = options.outbox;
    this.#notifications = options.notifications;
    this.#clock = options.clock ?? systemClock;
  }

  async observe(input: SlaObservationInput): Promise<SlaEvaluationResult> {
    assertObservation(input);
    const observedAt = input.observedAt ?? nowIso(this.#clock);
    const scope = resolveObservationScope(input);
    const thresholds = (await this.#thresholds.list(input))
      .filter((threshold) => thresholdMatches(threshold, input, scope));
    const evaluations: SlaThresholdEvaluation[] = [];
    const events: SlaPublishedEvent[] = [];

    for (const threshold of thresholds) {
      assertThreshold(threshold);
      const key = slaObservationStateKey(threshold, scope);
      const previous = await this.#states.get(key) ??
        initialState(threshold, scope, key, observedAt, input.observation);
      const breached = compare(input.observation, threshold);
      const transition = buildTransition({
        previous,
        threshold,
        scope,
        observation: input.observation,
        observedAt,
        breached,
      });
      const state = await this.#states.put(transition.state);
      let event: SlaPublishedEvent | undefined;
      if (transition.eventType) {
        event = await this.#publishTransition({
          type: transition.eventType,
          previousState: previous.state,
          state,
          threshold,
          input,
          scope,
          observedAt,
          breachDurationSeconds: transition.breachDurationSeconds,
        });
        events.push(event);
      }
      evaluations.push(Object.freeze({
        threshold: cloneThreshold(threshold),
        key,
        breached,
        previousState: previous.state,
        state,
        ...(event ? { event } : {}),
      }));
    }

    return Object.freeze({
      observedAt,
      evaluations: Object.freeze(evaluations),
      events: Object.freeze(events),
    });
  }

  async #publishTransition(input: {
    readonly type: SlaTransitionEventType;
    readonly previousState: SlaState;
    readonly state: SlaObservationState;
    readonly threshold: SlaThreshold;
    readonly input: SlaObservationInput;
    readonly scope: ResolvedSlaScope;
    readonly observedAt: IsoTimestamp;
    readonly breachDurationSeconds?: number;
  }): Promise<SlaPublishedEvent> {
    const payload = slaEventPayload(input);
    const domainEvent = createDomainEvent({
      type: input.type,
      aggregateType: "sla.threshold",
      aggregateId: input.threshold.id,
      payload,
      metadata: compactJsonObject({
        requestId: input.input.requestId,
        correlationId: input.input.correlationId,
      }),
    }, {
      clock: fixedClock(input.observedAt),
    }) as DomainEvent<SlaEventPayload>;

    await this.#outbox?.append(domainEvent);

    const audit = await this.#observability?.appendAudit({
      id: `audit_${domainEvent.id}`,
      eventClass: "compliance",
      type: input.type,
      severity: auditSeverityFor(input.type),
      actor: input.input.actor,
      spaceId: input.scope.scope === "space" ? input.scope.targetId : undefined,
      groupId: input.input.groupId,
      targetType: "sla.threshold",
      targetId: input.threshold.id,
      payload,
      occurredAt: input.observedAt,
      requestId: input.input.requestId,
      correlationId: input.input.correlationId,
    });

    const notification = input.type === "sla-breach-detected" &&
        this.#notifications
      ? await this.#notifications.publish({
        type: "sla-breach-detected",
        subject: `${input.threshold.dimension} breached`,
        severity: "warning",
        metadata: {
          ...payload,
          domainEventId: domainEvent.id,
          ...(audit ? { auditEventId: audit.event.id } : {}),
        },
      })
      : undefined;

    return Object.freeze({
      type: input.type,
      payload,
      domainEvent,
      ...(audit ? { auditEventId: audit.event.id } : {}),
      ...(notification ? { notification } : {}),
    });
  }
}

function isThresholdArray(
  value: readonly SlaThreshold[] | SlaThresholdStore,
): value is readonly SlaThreshold[] {
  return Array.isArray(value);
}

interface ResolvedSlaScope {
  readonly scope: SlaScope;
  readonly targetId?: string;
}

interface TransitionInput {
  readonly previous: SlaObservationState;
  readonly threshold: SlaThreshold;
  readonly scope: ResolvedSlaScope;
  readonly observation: number;
  readonly observedAt: IsoTimestamp;
  readonly breached: boolean;
}

interface TransitionResult {
  readonly state: SlaObservationState;
  readonly eventType?: SlaTransitionEventType;
  readonly breachDurationSeconds?: number;
}

export function slaObservationStateKey(
  threshold: SlaThreshold,
  scope: ResolvedSlaScope = {
    scope: threshold.scope,
    targetId: threshold.targetId,
  },
): string {
  return [
    threshold.id,
    scope.scope,
    scope.targetId ?? "kernel-global",
  ].join(":");
}

function buildTransition(input: TransitionInput): TransitionResult {
  const breachWindows = input.threshold.breachConsecutiveWindows ??
    DEFAULT_SLA_BREACH_CONSECUTIVE_WINDOWS;
  const recoveryWindows = input.threshold.recoveryConsecutiveWindows ??
    DEFAULT_SLA_RECOVERY_CONSECUTIVE_WINDOWS;

  switch (input.previous.state) {
    case "ok":
      if (!input.breached) return unchanged(input);
      if (breachWindows <= 1) {
        return changed(input, "breached", "sla-breach-detected", {
          openedAt: input.observedAt,
          consecutiveBreaches: 1,
        });
      }
      return changed(input, "warning", "sla-warning-raised", {
        consecutiveBreaches: 1,
      });
    case "warning": {
      if (!input.breached) {
        return changed(input, "ok", undefined, {
          consecutiveBreaches: 0,
          consecutiveRecoveries: 0,
          openedAt: undefined,
        });
      }
      const consecutiveBreaches = input.previous.consecutiveBreaches + 1;
      if (consecutiveBreaches >= breachWindows) {
        return changed(input, "breached", "sla-breach-detected", {
          openedAt: input.observedAt,
          consecutiveBreaches,
        });
      }
      return unchanged(input, {
        consecutiveBreaches,
        consecutiveRecoveries: 0,
      });
    }
    case "breached":
      if (input.breached) {
        return unchanged(input, {
          consecutiveBreaches: input.previous.consecutiveBreaches + 1,
          consecutiveRecoveries: 0,
        });
      }
      return changed(input, "recovering", "sla-recovering", {
        openedAt: input.previous.openedAt,
        consecutiveRecoveries: 1,
      });
    case "recovering": {
      if (input.breached) {
        return changed(input, "breached", undefined, {
          consecutiveBreaches: input.previous.consecutiveBreaches + 1,
          consecutiveRecoveries: 0,
          openedAt: input.previous.openedAt,
        });
      }
      const consecutiveRecoveries = input.previous.consecutiveRecoveries + 1;
      if (consecutiveRecoveries >= recoveryWindows) {
        const duration = input.previous.openedAt
          ? secondsBetween(input.previous.openedAt, input.observedAt)
          : undefined;
        return changed(input, "ok", "sla-recovered", {
          consecutiveBreaches: 0,
          consecutiveRecoveries,
          openedAt: undefined,
          breachDurationSeconds: duration,
        });
      }
      return unchanged(input, {
        consecutiveRecoveries,
        consecutiveBreaches: 0,
      });
    }
  }
}

function unchanged(
  input: TransitionInput,
  overrides: Partial<SlaObservationState> = {},
): TransitionResult {
  return {
    state: nextState(input, input.previous.state, {
      enteredAt: input.previous.enteredAt,
      openedAt: input.previous.openedAt,
      consecutiveBreaches: input.previous.consecutiveBreaches,
      consecutiveRecoveries: input.previous.consecutiveRecoveries,
      ...overrides,
    }),
  };
}

function changed(
  input: TransitionInput,
  state: SlaState,
  eventType: SlaTransitionEventType | undefined,
  overrides: Partial<SlaObservationState> & {
    readonly breachDurationSeconds?: number;
  } = {},
): TransitionResult {
  const next = nextState(input, state, {
    enteredAt: input.observedAt,
    openedAt: overrides.openedAt,
    consecutiveBreaches: 0,
    consecutiveRecoveries: 0,
    ...overrides,
  });
  return {
    state: next,
    ...(eventType ? { eventType } : {}),
    ...(overrides.breachDurationSeconds !== undefined
      ? { breachDurationSeconds: overrides.breachDurationSeconds }
      : {}),
  };
}

function nextState(
  input: TransitionInput,
  state: SlaState,
  overrides: Partial<SlaObservationState>,
): SlaObservationState {
  return Object.freeze({
    key: input.previous.key,
    thresholdId: input.threshold.id,
    dimension: input.threshold.dimension,
    scope: input.scope.scope,
    ...(input.scope.targetId ? { targetId: input.scope.targetId } : {}),
    state,
    enteredAt: overrides.enteredAt ?? input.observedAt,
    ...(overrides.openedAt ? { openedAt: overrides.openedAt } : {}),
    observation: input.observation,
    consecutiveBreaches: overrides.consecutiveBreaches ?? 0,
    consecutiveRecoveries: overrides.consecutiveRecoveries ?? 0,
    updatedAt: input.observedAt,
  });
}

function initialState(
  threshold: SlaThreshold,
  scope: ResolvedSlaScope,
  key: string,
  observedAt: IsoTimestamp,
  observation: number,
): SlaObservationState {
  return Object.freeze({
    key,
    thresholdId: threshold.id,
    dimension: threshold.dimension,
    scope: scope.scope,
    ...(scope.targetId ? { targetId: scope.targetId } : {}),
    state: "ok",
    enteredAt: observedAt,
    observation,
    consecutiveBreaches: 0,
    consecutiveRecoveries: 0,
    updatedAt: observedAt,
  });
}

function slaEventPayload(input: {
  readonly type: SlaTransitionEventType;
  readonly previousState: SlaState;
  readonly state: SlaObservationState;
  readonly threshold: SlaThreshold;
  readonly input: SlaObservationInput;
  readonly scope: ResolvedSlaScope;
  readonly observedAt: IsoTimestamp;
  readonly breachDurationSeconds?: number;
}): SlaEventPayload {
  return compactJsonObject({
    thresholdId: input.threshold.id,
    dimension: input.threshold.dimension,
    scope: input.scope.scope,
    targetId: input.scope.targetId ?? null,
    state: input.state.state,
    previousState: input.previousState,
    windowSeconds: input.threshold.windowSeconds ??
      DEFAULT_SLA_WINDOW_SECONDS,
    observation: input.state.observation,
    comparator: input.threshold.comparator,
    value: input.threshold.value,
    thresholdValue: input.threshold.value,
    observedAt: input.observedAt,
    breachDurationSeconds: input.breachDurationSeconds,
    windowStart: input.input.windowStart,
    windowEnd: input.input.windowEnd,
  }) as SlaEventPayload;
}

function thresholdMatches(
  threshold: SlaThreshold,
  input: SlaObservationInput,
  scope: ResolvedSlaScope,
): boolean {
  if (input.thresholdId && threshold.id !== input.thresholdId) return false;
  if (threshold.dimension !== input.dimension) return false;
  if (threshold.scope !== scope.scope) return false;
  if (threshold.scope === "kernel-global") return true;
  if (!scope.targetId) return false;
  return !threshold.targetId || threshold.targetId === scope.targetId;
}

function resolveObservationScope(input: SlaObservationInput): ResolvedSlaScope {
  if (input.scope) {
    return {
      scope: input.scope,
      targetId: input.targetId ?? input.spaceId ?? input.orgId,
    };
  }
  if (input.spaceId) return { scope: "space", targetId: input.spaceId };
  if (input.orgId) return { scope: "org", targetId: input.orgId };
  return { scope: "kernel-global" };
}

function compare(observation: number, threshold: SlaThreshold): boolean {
  switch (threshold.comparator) {
    case "gt":
      return observation > threshold.value;
    case "gte":
      return observation >= threshold.value;
    case "lt":
      return observation < threshold.value;
    case "lte":
      return observation <= threshold.value;
  }
}

function assertObservation(input: SlaObservationInput): void {
  if (!input.dimension) throw new TypeError("SLA dimension is required");
  if (!Number.isFinite(input.observation)) {
    throw new TypeError("SLA observation must be a finite number");
  }
}

function assertThreshold(threshold: SlaThreshold): void {
  if (!threshold.id) throw new TypeError("SLA threshold id is required");
  if (!threshold.dimension) {
    throw new TypeError("SLA threshold dimension is required");
  }
  if (!Number.isFinite(threshold.value) || threshold.value < 0) {
    throw new TypeError("SLA threshold value must be non-negative");
  }
  assertPositiveInteger(
    threshold.windowSeconds ?? DEFAULT_SLA_WINDOW_SECONDS,
    "SLA threshold windowSeconds",
  );
  assertPositiveInteger(
    threshold.breachConsecutiveWindows ??
      DEFAULT_SLA_BREACH_CONSECUTIVE_WINDOWS,
    "SLA threshold breachConsecutiveWindows",
  );
  assertPositiveInteger(
    threshold.recoveryConsecutiveWindows ??
      DEFAULT_SLA_RECOVERY_CONSECUTIVE_WINDOWS,
    "SLA threshold recoveryConsecutiveWindows",
  );
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function auditSeverityFor(type: SlaTransitionEventType): AuditSeverity {
  switch (type) {
    case "sla-breach-detected":
    case "sla-recovering":
    case "sla-warning-raised":
      return "warning";
    case "sla-recovered":
      return "info";
  }
}

function secondsBetween(start: IsoTimestamp, end: IsoTimestamp): number {
  return Math.max(
    0,
    Math.floor((new Date(end).getTime() - new Date(start).getTime()) / 1000),
  );
}

function fixedClock(iso: IsoTimestamp): Clock {
  return { now: () => new Date(iso) };
}

function compactJsonObject(
  input: Record<string, unknown>,
): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value as JsonObject[string];
  }
  return output;
}

function cloneThreshold(threshold: SlaThreshold): SlaThreshold {
  return Object.freeze(structuredClone(threshold) as SlaThreshold);
}

function cloneState(state: SlaObservationState): SlaObservationState {
  return deepFreeze(structuredClone(state) as SlaObservationState);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
