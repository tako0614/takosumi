import {
  type CloudflareWorkerEnv as Env,
  type CloudflareWorkerHandler,
  createCloudflareWorker,
} from "./handler.ts";

export class TakosCoordinationObject {
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
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
  }

  async acquireLease(
    input: CoordinationLeaseInput,
  ): Promise<CoordinationLease> {
    const now = Date.now();
    const existing = await this.getLease(input.scope);
    if (existing && Date.parse(existing.expiresAt) > now) {
      return { ...existing, acquired: false };
    }
    const lease: CoordinationLease = {
      scope: input.scope,
      holderId: input.holderId,
      token: crypto.randomUUID(),
      acquired: true,
      expiresAt: new Date(now + input.ttlMs).toISOString(),
      metadata: input.metadata,
    };
    await this.state.storage.put(leaseKey(input.scope), lease);
    return lease;
  }

  async renewLease(
    input: CoordinationRenewInput,
  ): Promise<CoordinationLease> {
    const existing = await this.getLease(input.scope);
    if (
      !existing || existing.holderId !== input.holderId ||
      existing.token !== input.token
    ) {
      throw new Error(`coordination lease not held: ${input.scope}`);
    }
    const lease: CoordinationLease = {
      ...existing,
      acquired: true,
      expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
    };
    await this.state.storage.put(leaseKey(input.scope), lease);
    return lease;
  }

  async releaseLease(input: CoordinationReleaseInput): Promise<boolean> {
    const existing = await this.getLease(input.scope);
    if (
      !existing || existing.holderId !== input.holderId ||
      existing.token !== input.token
    ) {
      return false;
    }
    await this.state.storage.delete(leaseKey(input.scope));
    return true;
  }

  async getLease(scope: string): Promise<CoordinationLease | undefined> {
    if (!scope) return undefined;
    const lease = await this.state.storage.get<CoordinationLease>(
      leaseKey(scope),
    );
    if (!lease) return undefined;
    if (Date.parse(lease.expiresAt) <= Date.now()) {
      await this.state.storage.delete(leaseKey(scope));
      return undefined;
    }
    return lease;
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
    return alarm;
  }

  async cancelAlarm(id: string): Promise<boolean> {
    if (!id) return false;
    const existing = await this.state.storage.get(alarmKey(id));
    await this.state.storage.delete(alarmKey(id));
    return existing !== undefined;
  }

  async listAlarms(scope?: string): Promise<readonly CoordinationAlarm[]> {
    const alarms = await this.state.storage.list<CoordinationAlarm>({
      prefix: "alarm:",
    });
    return [...alarms.values()]
      .filter((alarm) => scope === undefined || alarm.scope === scope)
      .sort((left, right) =>
        left.fireAt.localeCompare(right.fireAt) ||
        left.id.localeCompare(right.id)
      );
  }
}

interface DurableObjectState {
  readonly storage: DurableObjectStorage;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(
    options?: { readonly prefix?: string },
  ): Promise<Map<string, T>>;
}

interface CoordinationLease {
  readonly scope: string;
  readonly holderId: string;
  readonly token: string;
  readonly acquired: boolean;
  readonly expiresAt: string;
  readonly metadata?: Record<string, unknown>;
}

interface CoordinationLeaseInput {
  readonly scope: string;
  readonly holderId: string;
  readonly ttlMs: number;
  readonly metadata?: Record<string, unknown>;
}

interface CoordinationRenewInput {
  readonly scope: string;
  readonly holderId: string;
  readonly token: string;
  readonly ttlMs: number;
}

interface CoordinationReleaseInput {
  readonly scope: string;
  readonly holderId: string;
  readonly token: string;
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

const worker: CloudflareWorkerHandler = createCloudflareWorker();

export default worker;

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const value = await request.json();
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("request body must be a JSON object");
}

function requireString(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== "string" || !value) {
    throw new Error(`field ${field} must be a non-empty string`);
  }
  return value;
}

function requireNumber(
  body: Record<string, unknown>,
  field: string,
): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`field ${field} must be a finite number`);
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
    throw new Error(`field ${field} must be a JSON object when present`);
  }
  return value as Record<string, unknown>;
}

function parseLeaseInput(
  body: Record<string, unknown>,
): CoordinationLeaseInput {
  return {
    scope: requireString(body, "scope"),
    holderId: requireString(body, "holderId"),
    ttlMs: requireNumber(body, "ttlMs"),
    metadata: optionalRecord(body, "metadata"),
  };
}

function parseRenewInput(
  body: Record<string, unknown>,
): CoordinationRenewInput {
  return {
    scope: requireString(body, "scope"),
    holderId: requireString(body, "holderId"),
    token: requireString(body, "token"),
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
