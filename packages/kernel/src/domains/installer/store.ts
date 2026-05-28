/**
 * In-memory persistence for Installation + Deployment records.
 *
 * Wave 5 implementation — keeps things in process memory. A SQL-backed
 * variant is a follow-up wave concern.
 *
 * The in-memory stores intentionally do not persist across process
 * restarts. When this module detects that the host process is running in
 * a production-shaped environment (`DENO_DEPLOYMENT_ID`, `PRODUCTION`,
 * `NODE_ENV=production`, etc.), the first construction of either store
 * emits a warning so operators do not silently lose Installations on
 * restart.
 */
import type { Deployment, Installation } from "takosumi-contract/installer-api";

let warnedProductionInMemoryStore = false;

/**
 * Detect process env markers that look like a production deployment of
 * either Deno (Deno Deploy injects `DENO_DEPLOYMENT_ID`) or Node-style
 * services (`PRODUCTION`, `NODE_ENV=production`). The lookup goes through
 * the runtime adapter equivalent on both Deno and Node without
 * hard-importing either, so the function compiles on Workers as well.
 */
function isProductionShapedEnv(): boolean {
  const env = readEnvMap();
  if (env.get("DENO_DEPLOYMENT_ID")) return true;
  if (env.get("PRODUCTION")) return true;
  const nodeEnv = env.get("NODE_ENV");
  if (typeof nodeEnv === "string" && nodeEnv.toLowerCase() === "production") {
    return true;
  }
  return false;
}

interface ProcessLike {
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface DenoLike {
  readonly env?: { get(name: string): string | undefined };
}

function readEnvMap(): { get(name: string): string | undefined } {
  // Deno path: `Deno.env.get` is read-only metadata.
  const deno = (globalThis as { Deno?: DenoLike }).Deno;
  if (deno?.env && typeof deno.env.get === "function") {
    return { get: (name: string) => deno.env!.get(name) };
  }
  // Node path: `process.env` is a plain dictionary.
  const proc = (globalThis as { process?: ProcessLike }).process;
  if (proc?.env) {
    return { get: (name: string) => proc.env?.[name] };
  }
  // Workers / unknown runtime — no env access.
  return { get: () => undefined };
}

function maybeWarnProductionInMemoryStore(storeName: string): void {
  if (warnedProductionInMemoryStore) return;
  if (!isProductionShapedEnv()) return;
  warnedProductionInMemoryStore = true;
  console.warn(
    `[takosumi-kernel] WARNING: ${storeName} used in production-shaped env; data will not persist`,
  );
}

export interface RollbackEvent {
  readonly installationId: string;
  readonly rolledBackFrom: string | null;
  readonly rolledBackTo: string;
  readonly createdAt: number;
}

export interface InstallationStore {
  put(installation: Installation): Promise<Installation>;
  get(id: string): Promise<Installation | undefined>;
  list(spaceId?: string): Promise<readonly Installation[]>;
  patch(
    id: string,
    patch: Partial<Pick<Installation, "currentDeploymentId" | "status">>,
  ): Promise<Installation | undefined>;
}

export interface DeploymentStore {
  put(deployment: Deployment): Promise<Deployment>;
  get(id: string): Promise<Deployment | undefined>;
  listForInstallation(installationId: string): Promise<readonly Deployment[]>;
  recordRollback?(event: RollbackEvent): Promise<void>;
  listRollbackEvents?(
    installationId: string,
  ): Promise<readonly RollbackEvent[]>;
}

export class InMemoryInstallationStore implements InstallationStore {
  readonly #rows = new Map<string, Installation>();

  constructor() {
    maybeWarnProductionInMemoryStore("InMemoryInstallationStore");
  }

  put(installation: Installation): Promise<Installation> {
    this.#rows.set(installation.id, installation);
    return Promise.resolve(installation);
  }

  get(id: string): Promise<Installation | undefined> {
    return Promise.resolve(this.#rows.get(id));
  }

  list(spaceId?: string): Promise<readonly Installation[]> {
    const rows = Array.from(this.#rows.values());
    if (spaceId === undefined) return Promise.resolve(rows);
    return Promise.resolve(rows.filter((row) => row.spaceId === spaceId));
  }

  patch(
    id: string,
    patch: Partial<Pick<Installation, "currentDeploymentId" | "status">>,
  ): Promise<Installation | undefined> {
    const existing = this.#rows.get(id);
    if (!existing) return Promise.resolve(undefined);
    const updated: Installation = { ...existing, ...patch };
    this.#rows.set(id, updated);
    return Promise.resolve(updated);
  }
}

export class InMemoryDeploymentStore implements DeploymentStore {
  readonly #rows = new Map<string, Deployment>();
  readonly #rollbackEvents: RollbackEvent[] = [];

  constructor() {
    maybeWarnProductionInMemoryStore("InMemoryDeploymentStore");
  }

  put(deployment: Deployment): Promise<Deployment> {
    this.#rows.set(deployment.id, deployment);
    return Promise.resolve(deployment);
  }

  get(id: string): Promise<Deployment | undefined> {
    return Promise.resolve(this.#rows.get(id));
  }

  listForInstallation(
    installationId: string,
  ): Promise<readonly Deployment[]> {
    return Promise.resolve(
      Array.from(this.#rows.values()).filter((row) =>
        row.installationId === installationId
      ),
    );
  }

  recordRollback(event: RollbackEvent): Promise<void> {
    this.#rollbackEvents.push(event);
    return Promise.resolve();
  }

  listRollbackEvents(
    installationId: string,
  ): Promise<readonly RollbackEvent[]> {
    return Promise.resolve(
      this.#rollbackEvents.filter((event) =>
        event.installationId === installationId
      ),
    );
  }
}
