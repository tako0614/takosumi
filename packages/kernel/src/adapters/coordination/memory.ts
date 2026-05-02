import type {
  CoordinationAlarm,
  CoordinationAlarmInput,
  CoordinationLease,
  CoordinationLeaseInput,
  CoordinationPort,
  CoordinationReleaseInput,
  CoordinationRenewInput,
} from "./types.ts";

export interface MemoryCoordinationOptions {
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

export class MemoryCoordinationAdapter implements CoordinationPort {
  readonly #leases = new Map<string, CoordinationLease>();
  readonly #alarms = new Map<string, CoordinationAlarm>();
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: MemoryCoordinationOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  acquireLease(input: CoordinationLeaseInput): Promise<CoordinationLease> {
    const now = this.#clock();
    const existing = this.#leases.get(input.scope);
    if (existing && new Date(existing.expiresAt).getTime() > now.getTime()) {
      return Promise.resolve(Object.freeze({
        ...structuredClone(existing),
        acquired: false,
      }));
    }
    const lease = Object.freeze({
      scope: input.scope,
      holderId: input.holderId,
      token: `lease_${this.#idGenerator()}`,
      acquired: true,
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      metadata: input.metadata ? { ...input.metadata } : undefined,
    });
    this.#leases.set(input.scope, lease);
    return Promise.resolve(cloneLease(lease));
  }

  renewLease(input: CoordinationRenewInput): Promise<CoordinationLease> {
    const lease = this.#leases.get(input.scope);
    if (
      !lease || lease.holderId !== input.holderId || lease.token !== input.token
    ) {
      return Promise.reject(
        new Error(`coordination lease not held: ${input.scope}`),
      );
    }
    const renewed = Object.freeze({
      ...structuredClone(lease),
      acquired: true,
      expiresAt: new Date(this.#clock().getTime() + input.ttlMs).toISOString(),
    });
    this.#leases.set(input.scope, renewed);
    return Promise.resolve(cloneLease(renewed));
  }

  releaseLease(input: CoordinationReleaseInput): Promise<boolean> {
    const lease = this.#leases.get(input.scope);
    if (
      !lease || lease.holderId !== input.holderId || lease.token !== input.token
    ) {
      return Promise.resolve(false);
    }
    return Promise.resolve(this.#leases.delete(input.scope));
  }

  getLease(scope: string): Promise<CoordinationLease | undefined> {
    const lease = this.#leases.get(scope);
    if (!lease) return Promise.resolve(undefined);
    if (new Date(lease.expiresAt).getTime() <= this.#clock().getTime()) {
      this.#leases.delete(scope);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(cloneLease(lease));
  }

  scheduleAlarm(input: CoordinationAlarmInput): Promise<CoordinationAlarm> {
    const alarm = Object.freeze({
      id: input.id,
      scope: input.scope,
      fireAt: input.fireAt,
      payload: input.payload ? { ...input.payload } : undefined,
    });
    this.#alarms.set(input.id, alarm);
    return Promise.resolve(cloneAlarm(alarm));
  }

  cancelAlarm(id: string): Promise<boolean> {
    return Promise.resolve(this.#alarms.delete(id));
  }

  listAlarms(scope?: string): Promise<readonly CoordinationAlarm[]> {
    return Promise.resolve(
      [...this.#alarms.values()]
        .filter((alarm) => !scope || alarm.scope === scope)
        .sort((left, right) =>
          left.fireAt.localeCompare(right.fireAt) ||
          left.id.localeCompare(right.id)
        )
        .map(cloneAlarm),
    );
  }
}

function cloneLease(lease: CoordinationLease): CoordinationLease {
  return Object.freeze(structuredClone(lease));
}

function cloneAlarm(alarm: CoordinationAlarm): CoordinationAlarm {
  return Object.freeze(structuredClone(alarm));
}
