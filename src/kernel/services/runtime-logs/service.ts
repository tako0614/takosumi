import { redactJsonObject, redactString } from "../observability/redaction.ts";
import { decideRuntimeLogRetention } from "./retention.ts";
import type {
  RuntimeLogAppendInput,
  RuntimeLogEvent,
  RuntimeLogQuery,
  RuntimeLogRetentionDecision,
  RuntimeLogRetentionPolicy,
} from "./types.ts";

export interface RuntimeLogsService {
  append(input: RuntimeLogAppendInput): Promise<RuntimeLogEvent>;
  query(query?: RuntimeLogQuery): Promise<readonly RuntimeLogEvent[]>;
  decideRetention(now: string): RuntimeLogRetentionDecision;
  pruneExpired(now: string): Promise<RuntimeLogRetentionDecision>;
}

export class InMemoryRuntimeLogsService implements RuntimeLogsService {
  readonly #events: RuntimeLogEvent[] = [];
  readonly #policy: RuntimeLogRetentionPolicy;
  #nextId = 1;

  constructor(policy: Partial<RuntimeLogRetentionPolicy> = {}) {
    this.#policy = {
      windowMs: policy.windowMs ?? 24 * 60 * 60 * 1000,
    };
  }

  append(input: RuntimeLogAppendInput): Promise<RuntimeLogEvent> {
    const event: RuntimeLogEvent = {
      ...input,
      id: input.id ?? `runtime_log_${this.#nextId++}`,
      message: redactString(input.message),
      payload: input.payload ? redactJsonObject(input.payload) : undefined,
    };
    this.#events.push(cloneRuntimeLogEvent(event));
    return Promise.resolve(cloneRuntimeLogEvent(event));
  }

  query(query: RuntimeLogQuery = {}): Promise<readonly RuntimeLogEvent[]> {
    const matched = this.#events
      .filter((event) => matchesRuntimeLogQuery(event, query))
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
    const limited = query.limit === undefined
      ? matched
      : matched.slice(0, Math.max(0, Math.floor(query.limit)));
    return Promise.resolve(limited.map(cloneRuntimeLogEvent));
  }

  decideRetention(now: string): RuntimeLogRetentionDecision {
    return decideRuntimeLogRetention({
      now,
      policy: this.#policy,
      oldestObservedAt: oldestObservedAt(this.#events),
    });
  }

  pruneExpired(now: string): Promise<RuntimeLogRetentionDecision> {
    const decision = this.decideRetention(now);
    if (!decision.shouldPrune) return Promise.resolve(decision);

    const retained = this.#events.filter((event) =>
      event.observedAt >= decision.retainAfter
    );
    this.#events.splice(0, this.#events.length, ...retained);
    return Promise.resolve(decision);
  }
}

function matchesRuntimeLogQuery(
  event: RuntimeLogEvent,
  query: RuntimeLogQuery,
): boolean {
  if (query.spaceId && event.spaceId !== query.spaceId) return false;
  if (query.groupId && event.groupId !== query.groupId) return false;
  if (query.workerId && event.workerId !== query.workerId) return false;
  if (query.deploymentId && event.deploymentId !== query.deploymentId) {
    return false;
  }
  if (query.instanceId && event.instanceId !== query.instanceId) return false;
  if (query.stream && event.stream !== query.stream) return false;
  if (query.level) {
    const levels = Array.isArray(query.level) ? query.level : [query.level];
    if (!levels.includes(event.level)) return false;
  }
  if (query.since && event.observedAt < query.since) return false;
  if (query.until && event.observedAt > query.until) return false;
  if (query.search && !event.message.includes(query.search)) return false;
  return true;
}

function cloneRuntimeLogEvent(event: RuntimeLogEvent): RuntimeLogEvent {
  return structuredClone(event);
}

function oldestObservedAt(
  events: readonly RuntimeLogEvent[],
): string | undefined {
  return events.reduce<string | undefined>(
    (oldest, event) =>
      oldest === undefined || event.observedAt < oldest
        ? event.observedAt
        : oldest,
    undefined,
  );
}
