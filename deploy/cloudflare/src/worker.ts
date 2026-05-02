import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  readonly TAKOS_D1: D1Database;
  readonly TAKOS_ARTIFACTS: R2Bucket;
  readonly TAKOS_QUEUE: Queue<unknown>;
  readonly TAKOS_COORDINATION: DurableObjectNamespace;
  readonly TAKOS_WORKLOAD_CONTAINER: DurableObjectNamespace;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
}

interface R2Bucket {
  head(key: string): Promise<unknown>;
}

interface Queue<T> {
  send(message: T): Promise<void>;
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export class TakosWorkloadContainer extends Container {
  override defaultPort = 8080;
  override requiredPorts = [8080];
  override sleepAfter = "10m";
  override enableInternet = true;
  override pingEndpoint = "healthz";
  override envVars = {
    TAKOS_RUNTIME_MODE: "cloudflare-container",
  };
}

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
            result: await this.acquireLease(
              body as unknown as CoordinationLeaseInput,
            ),
          });
        case "renew-lease":
          return Response.json({
            result: await this.renewLease(
              body as unknown as CoordinationRenewInput,
            ),
          });
        case "release-lease":
          return Response.json({
            result: await this.releaseLease(
              body as unknown as CoordinationReleaseInput,
            ),
          });
        case "get-lease":
          return Response.json({
            result: await this.getLease(String(body.scope ?? "")),
          });
        case "schedule-alarm":
          return Response.json({
            result: await this.scheduleAlarm(
              body as unknown as CoordinationAlarmInput,
            ),
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, provider: "cloudflare" });
    }
    if (url.pathname.startsWith("/coordination/")) {
      const id = env.TAKOS_COORDINATION.idFromName("takos-control-plane");
      const targetPath = `/${url.pathname.slice("/coordination/".length)}`;
      return env.TAKOS_COORDINATION.get(id).fetch(
        new Request(new URL(targetPath, request.url), request),
      );
    }
    if (url.pathname.startsWith("/runtime/")) {
      const instanceName = url.searchParams.get("instance") ?? "default";
      return getContainer(env.TAKOS_WORKLOAD_CONTAINER, instanceName).fetch(
        request,
      );
    }
    if (url.pathname === "/queue/test" && request.method === "POST") {
      await env.TAKOS_QUEUE.send(await request.json());
      return Response.json({ queued: true });
    }
    if (url.pathname === "/storage/healthz") {
      await env.TAKOS_D1.prepare("select 1").first();
      await env.TAKOS_ARTIFACTS.head("healthz");
      return Response.json({ ok: true, storage: "cloudflare" });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const value = await request.json();
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("request body must be a JSON object");
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
