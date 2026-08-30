import type { CloudflareWorkerEnv as Env } from "../handler.ts";

const MAX_JOINED_LEASE_REFERENCES = 64;

export class CoordinationObject {
  constructor(
    readonly state: DurableObjectState,
    readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, role: "coordination" });
    }
    if (request.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    try {
      const body = await readJsonObject(request);
      switch (trimPath(url.pathname)) {
        case "acquire-lease":
          return Response.json({
            result: await this.acquireLease(parseLeaseInput(body)),
          });
        case "renew-lease":
          return Response.json({
            result: await this.renewLease(parseRenewInput(body)),
          });
        case "release-lease":
          return Response.json({
            result: await this.releaseLease(parseReleaseInput(body)),
          });
        case "get-lease":
          return Response.json({
            result: await this.getLease(String(body.scope ?? "")),
          });
        case "schedule-alarm":
          return Response.json({
            result: await this.scheduleAlarm(parseAlarmInput(body)),
          });
        case "cancel-alarm":
          return Response.json({
            result: await this.cancelAlarm(String(body.id ?? "")),
          });
        case "list-alarms":
          return Response.json({
            result: await this.listAlarms(
              typeof body.scope === "string" ? body.scope : undefined,
            ),
          });
        case "run-due-alarms":
          return Response.json({
            result: await this.runDueAlarms(Date.now()),
          });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (error) {
      const invalidRequest = error instanceof InvalidCoordinationRequestError;
      return Response.json(
        {
          error: invalidRequest
            ? "invalid coordination request"
            : "coordination unavailable",
        },
        { status: invalidRequest ? 400 : 503 },
      );
    }
  }

  async acquireLease(
    input: CoordinationLeaseInput,
  ): Promise<CoordinationLease> {
    const now = Date.now();
    const existing = await this.getStoredLease(input.scope);
    if (existing) {
      if (
        input.joinExistingHolder === true &&
        existing.joinable === true &&
        existing.holderId === input.holderId &&
        (existing.activeReferenceIds?.length ?? 0) <
          MAX_JOINED_LEASE_REFERENCES
      ) {
        const referenceId = crypto.randomUUID();
        const lease: StoredCoordinationLease = {
          ...existing,
          expiresAt: new Date(
            Math.max(Date.parse(existing.expiresAt), now + input.ttlMs),
          ).toISOString(),
          activeReferenceIds: [
            ...new Set([
              ...(existing.activeReferenceIds ?? []),
              referenceId,
            ]),
          ],
        };
        await this.state.storage.put(leaseKey(input.scope), lease);
        return coordinationLeaseResponse(lease, true, referenceId);
      }
      return coordinationLeaseResponse(existing, false);
    }
    const joinable = input.joinExistingHolder === true;
    const referenceId = joinable ? crypto.randomUUID() : undefined;
    const lease: StoredCoordinationLease = {
      scope: input.scope,
      holderId: input.holderId,
      token: crypto.randomUUID(),
      expiresAt: new Date(now + input.ttlMs).toISOString(),
      metadata: input.metadata,
      joinable,
      ...(referenceId ? { activeReferenceIds: [referenceId] } : {}),
    };
    await this.state.storage.put(leaseKey(input.scope), lease);
    return coordinationLeaseResponse(lease, true, referenceId);
  }

  async renewLease(input: CoordinationRenewInput): Promise<CoordinationLease> {
    const existing = await this.getStoredLease(input.scope);
    if (
      !existing ||
      existing.holderId !== input.holderId ||
      existing.token !== input.token ||
      ((existing.activeReferenceIds?.length ?? 0) > 0 &&
        (input.referenceId === undefined ||
          !existing.activeReferenceIds!.includes(input.referenceId)))
    ) {
      return {
        scope: input.scope,
        holderId: input.holderId,
        token: input.token,
        acquired: false,
        expiresAt: existing?.expiresAt ?? new Date(0).toISOString(),
      };
    }
    const lease: StoredCoordinationLease = {
      ...existing,
      expiresAt: new Date(
        Math.max(
          Date.parse(existing.expiresAt),
          Date.now() + input.ttlMs,
        ),
      ).toISOString(),
    };
    await this.state.storage.put(leaseKey(input.scope), lease);
    return coordinationLeaseResponse(lease, true);
  }

  async releaseLease(input: CoordinationReleaseInput): Promise<boolean> {
    const existing = await this.getStoredLease(input.scope);
    if (
      !existing ||
      existing.holderId !== input.holderId ||
      existing.token !== input.token
    ) {
      return false;
    }
    const activeReferenceIds = existing.activeReferenceIds ?? [];
    if (activeReferenceIds.length > 0) {
      if (
        input.referenceId === undefined ||
        !activeReferenceIds.includes(input.referenceId)
      ) {
        return false;
      }
      const remaining = activeReferenceIds.filter(
        (referenceId) => referenceId !== input.referenceId,
      );
      if (remaining.length > 0) {
        await this.state.storage.put(leaseKey(input.scope), {
          ...existing,
          activeReferenceIds: remaining,
        } satisfies StoredCoordinationLease);
        return true;
      }
    }
    await this.state.storage.delete(leaseKey(input.scope));
    return true;
  }

  async getLease(scope: string): Promise<CoordinationLease | undefined> {
    const lease = await this.getStoredLease(scope);
    return lease ? coordinationLeaseResponse(lease, true) : undefined;
  }

  private async getStoredLease(
    scope: string,
  ): Promise<StoredCoordinationLease | undefined> {
    if (!scope) return undefined;
    const lease = await this.state.storage.get<StoredCoordinationLease>(
      leaseKey(scope),
    );
    if (!lease) return undefined;
    if (Date.parse(lease.expiresAt) <= Date.now()) {
      await this.state.storage.delete(leaseKey(scope));
      return undefined;
    }
    return normalizeStoredLease(lease);
  }

  async scheduleAlarm(
    input: CoordinationAlarmInput,
  ): Promise<CoordinationAlarm> {
    const alarm: CoordinationAlarm = {
      id: input.id,
      scope: input.scope,
      fireAt: input.fireAt,
      payload: input.payload,
    };
    await this.state.storage.put(alarmKey(input.id), alarm);
    await this.rescheduleDurableObjectAlarm();
    return alarm;
  }

  async cancelAlarm(id: string): Promise<boolean> {
    if (!id) return false;
    const existing = await this.state.storage.get(alarmKey(id));
    await this.state.storage.delete(alarmKey(id));
    await this.rescheduleDurableObjectAlarm();
    return existing !== undefined;
  }

  async listAlarms(scope?: string): Promise<readonly CoordinationAlarm[]> {
    const alarms = await this.state.storage.list<CoordinationAlarm>({
      prefix: "alarm:",
    });
    return [...alarms.values()]
      .filter((alarm) => scope === undefined || alarm.scope === scope)
      .sort(
        (left, right) =>
          left.fireAt.localeCompare(right.fireAt) ||
          left.id.localeCompare(right.id),
      );
  }

  async alarm(): Promise<void> {
    try {
      await this.runDueAlarms(Date.now());
    } catch {
      await this.rescheduleDurableObjectAlarm(Date.now() + 60_000);
    }
  }

  async runDueAlarms(nowMs: number): Promise<{
    readonly fired: readonly string[];
    readonly nextAlarmAt?: string;
  }> {
    const fired: string[] = [];
    const alarms = await this.state.storage.list<CoordinationAlarm>({
      prefix: "alarm:",
    });
    for (const [key, alarm] of alarms) {
      if (Date.parse(alarm.fireAt) > nowMs) continue;
      await this.state.storage.delete(key);
      fired.push(alarm.id);
    }
    await this.deleteExpiredLeases(nowMs);
    const nextAlarmMs = await this.rescheduleDurableObjectAlarm();
    return {
      fired: fired.sort(),
      ...(nextAlarmMs !== undefined
        ? { nextAlarmAt: new Date(nextAlarmMs).toISOString() }
        : {}),
    };
  }

  private async deleteExpiredLeases(nowMs: number): Promise<void> {
    const leases = await this.state.storage.list<StoredCoordinationLease>({
      prefix: "lease:",
    });
    for (const [key, lease] of leases) {
      if (Date.parse(lease.expiresAt) <= nowMs) {
        await this.state.storage.delete(key);
      }
    }
  }

  private async rescheduleDurableObjectAlarm(
    fallbackMs?: number,
  ): Promise<number | undefined> {
    if (typeof this.state.storage.setAlarm !== "function") return undefined;
    const alarms = await this.state.storage.list<CoordinationAlarm>({
      prefix: "alarm:",
    });
    let nextAlarmMs = fallbackMs;
    for (const alarm of alarms.values()) {
      const fireAtMs = Date.parse(alarm.fireAt);
      if (!Number.isFinite(fireAtMs)) continue;
      if (nextAlarmMs === undefined || fireAtMs < nextAlarmMs) {
        nextAlarmMs = fireAtMs;
      }
    }
    if (nextAlarmMs === undefined) {
      await this.state.storage.deleteAlarm?.();
      return undefined;
    }
    await this.state.storage.setAlarm(nextAlarmMs);
    return nextAlarmMs;
  }
}

interface DurableObjectState {
  readonly storage: DurableObjectStorage;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: {
    readonly prefix?: string;
  }): Promise<Map<string, T>>;
  setAlarm?(scheduledTime: number): Promise<void>;
  deleteAlarm?(): Promise<void>;
}

interface CoordinationLease {
  readonly scope: string;
  readonly holderId: string;
  readonly token: string;
  readonly referenceId?: string;
  readonly acquired: boolean;
  readonly expiresAt: string;
  readonly metadata?: Record<string, unknown>;
}

interface CoordinationLeaseInput {
  readonly scope: string;
  readonly holderId: string;
  readonly ttlMs: number;
  readonly metadata?: Record<string, unknown>;
  readonly joinExistingHolder?: boolean;
}

interface CoordinationRenewInput {
  readonly scope: string;
  readonly holderId: string;
  readonly token: string;
  readonly referenceId?: string;
  readonly ttlMs: number;
}

interface CoordinationReleaseInput {
  readonly scope: string;
  readonly holderId: string;
  readonly token: string;
  readonly referenceId?: string;
}

interface StoredCoordinationLease {
  readonly scope: string;
  readonly holderId: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly metadata?: Record<string, unknown>;
  /** Missing means a legacy exclusive generation. */
  readonly joinable?: boolean;
  /** Missing means a legacy one-owner generation. */
  readonly activeReferenceIds?: readonly string[];
}

interface CoordinationAlarm {
  readonly id: string;
  readonly scope: string;
  readonly fireAt: string;
  readonly payload?: Record<string, unknown>;
}

interface CoordinationAlarmInput {
  readonly id: string;
  readonly scope: string;
  readonly fireAt: string;
  readonly payload?: Record<string, unknown>;
}

class InvalidCoordinationRequestError extends Error {
  constructor() {
    super("invalid coordination request");
    this.name = "InvalidCoordinationRequestError";
  }
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new InvalidCoordinationRequestError();
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new InvalidCoordinationRequestError();
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value) {
    throw new InvalidCoordinationRequestError();
  }
  return value;
}

function requireNumber(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidCoordinationRequestError();
  }
  return value;
}

function optionalRecord(
  body: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidCoordinationRequestError();
  }
  return value as Record<string, unknown>;
}

function optionalBoolean(
  body: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new InvalidCoordinationRequestError();
  return value;
}

function optionalString(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value) {
    throw new InvalidCoordinationRequestError();
  }
  return value;
}

function parseLeaseInput(
  body: Record<string, unknown>,
): CoordinationLeaseInput {
  return {
    scope: requireString(body, "scope"),
    holderId: requireString(body, "holderId"),
    ttlMs: requireNumber(body, "ttlMs"),
    metadata: optionalRecord(body, "metadata"),
    joinExistingHolder: optionalBoolean(body, "joinExistingHolder"),
  };
}

function parseRenewInput(
  body: Record<string, unknown>,
): CoordinationRenewInput {
  return {
    scope: requireString(body, "scope"),
    holderId: requireString(body, "holderId"),
    token: requireString(body, "token"),
    referenceId: optionalString(body, "referenceId"),
    ttlMs: requireNumber(body, "ttlMs"),
  };
}

function parseReleaseInput(
  body: Record<string, unknown>,
): CoordinationReleaseInput {
  return {
    scope: requireString(body, "scope"),
    holderId: requireString(body, "holderId"),
    token: requireString(body, "token"),
    referenceId: optionalString(body, "referenceId"),
  };
}

function coordinationLeaseResponse(
  lease: StoredCoordinationLease,
  acquired: boolean,
  referenceId?: string,
): CoordinationLease {
  return {
    scope: lease.scope,
    holderId: lease.holderId,
    token: lease.token,
    ...(referenceId ? { referenceId } : {}),
    acquired,
    expiresAt: lease.expiresAt,
    ...(lease.metadata ? { metadata: lease.metadata } : {}),
  };
}

/**
 * Normalizes rows written before reference-tracked joining existed. Missing (or
 * malformed) join metadata is an exclusive holder+token generation, so legacy
 * callers can still renew and release it without inventing a member reference.
 * A joined generation is valid only when its persisted member list is non-empty.
 */
function normalizeStoredLease(
  lease: StoredCoordinationLease,
): StoredCoordinationLease {
  const activeReferenceIds =
    lease.joinable === true && Array.isArray(lease.activeReferenceIds)
      ? [
          ...new Set(
            lease.activeReferenceIds.filter(
              (referenceId): referenceId is string =>
                typeof referenceId === "string" && referenceId.length > 0,
            ),
          ),
        ]
      : [];
  return {
    ...lease,
    joinable: activeReferenceIds.length > 0,
    activeReferenceIds,
  };
}

function parseAlarmInput(
  body: Record<string, unknown>,
): CoordinationAlarmInput {
  return {
    id: requireString(body, "id"),
    scope: requireString(body, "scope"),
    fireAt: requireString(body, "fireAt"),
    payload: optionalRecord(body, "payload"),
  };
}

function trimPath(pathname: string): string {
  return pathname.replace(/^\/+|\/+$/g, "");
}

function leaseKey(scope: string): string {
  return `lease:${scope}`;
}

function alarmKey(id: string): string {
  return `alarm:${id}`;
}
