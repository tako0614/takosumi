/**
 * In-memory persistence for Installation + Deployment records.
 *
 * A durable, injectable SQL-backed variant now exists in `./store_sql.ts`
 * (`SqlInstallationStore` / `SqlDeploymentStore`). Bootstrap resolves it
 * automatically when a `sqlClient` is configured and falls back to these
 * in-memory stores only for dev / test. See `resolveInstallerStores` and the
 * fail-closed `assertDurableInstallerStoreOrWarn` durability gate in
 * `bootstrap.ts`, which refuses to boot a production/staging host that exposes
 * the Installer API on this in-memory ledger.
 *
 * The in-memory stores intentionally do not persist across process restarts
 * or isolate recycles. Because the Installation / Deployment ledger is the
 * space durable state of the Installer API, every construction of either
 * store emits a warning unless the host is provably a non-durable-safe
 * *development* shape:
 *
 *   - When process env is readable and does NOT look like a production
 *     deployment (`PRODUCTION` / `NODE_ENV=production`), we stay quiet —
 *     local dev / test.
 *   - When env says production, OR env is unreadable (Cloudflare Workers /
 *     unknown runtime, where durability also cannot be confirmed and an
 *     isolate recycle silently drops the ledger), we warn.
 *
 * The previous implementation only warned when env *positively* matched a
 * production marker, so the warning was structurally dead on Workers (a
 * documented production target) where env is unreadable. The warning is no
 * longer a once-per-process latch either: each store construction warns so
 * repeated/late construction is not silently swallowed.
 *
 * This per-construction warning is a backstop; the authoritative fail-closed
 * gate lives at bootstrap (`assertDurableInstallerStoreOrWarn`), which throws
 * when a production/staging host exposes the Installer API with no durable
 * store injected. A durable store is injected by the operator distribution
 * (or auto-resolved from a configured `sqlClient`); the service cannot force a
 * 503 from inside the store layer itself.
 */
import type { Deployment, Installation } from "takosumi-contract/installer-api";
import { currentRuntime } from "../../shared/runtime/index.ts";

/**
 * Decide whether an in-memory store construction should warn about
 * non-persistence. Returns `true` unless the host is a readable,
 * clearly-non-production env (local dev / test).
 */
function shouldWarnInMemoryStore(): boolean {
  const env = readEnvMap();
  if (env === undefined) {
    // Workers / unknown runtime — durability cannot be confirmed and an
    // isolate recycle silently drops the ledger, so warn.
    return true;
  }
  if (env.get("PRODUCTION")) return true;
  const nodeEnv = env.get("NODE_ENV");
  if (typeof nodeEnv === "string" && nodeEnv.toLowerCase() === "production") {
    return true;
  }
  // Readable env that does not look like production — local dev / test.
  return false;
}

/**
 * Return a reader over the runtime env surface, or `undefined` when no env
 * surface is available (Workers / unknown runtime). The distinction matters:
 * an unreadable env is treated as "cannot confirm durability" rather than
 * "definitely not production".
 */
function readEnvMap(): { get(name: string): string | undefined } | undefined {
  const runtime = currentRuntime();
  if (runtime.kind === "workers" || runtime.kind === "unknown") {
    return undefined;
  }
  return runtime.env;
}

function maybeWarnInMemoryStore(storeName: string): void {
  if (!shouldWarnInMemoryStore()) return;
  console.warn(
    `[takosumi-service] WARNING: ${storeName} is in-memory; Installation/Deployment ` +
      `records will NOT persist across restart or isolate recycle. Inject a ` +
      `durable store for production/staging.`,
  );
}

export interface RollbackEvent {
  readonly installationId: string;
  readonly rolledBackFrom: string | null;
  readonly rolledBackTo: string;
  readonly createdAt: number;
}

/**
 * Optional optimistic-concurrency guard for {@link InstallationStore.patch}.
 *
 * When supplied, the patch only matches the row when its
 * `current_deployment_id` still equals `currentDeploymentId` (the value the
 * caller pre-read and validated via `checkExpectedCurrentDeploymentId`). On a
 * durable SQL store this turns the dry-run → apply `expected.currentDeploymentId`
 * TOCTOU guard into an atomic compare-and-set so two replicas racing the same
 * Installation pointer cannot lose each other's write. When omitted, the patch
 * behaves exactly as before (unconditional update of an existing row).
 */
export interface InstallationPatchGuard {
  readonly currentDeploymentId: string | null;
}

/**
 * Thrown by a guarded {@link InstallationStore.patch} when the row still exists
 * but its `current_deployment_id` no longer matches the supplied guard — i.e.
 * a concurrent deploy advanced the pointer between the caller's pre-read and
 * this write. Distinct from a `patch` returning `undefined`, which means the
 * row vanished. The installer domain maps this to a closed-envelope
 * `failed_precondition` (HTTP 409), matching the fail-fast intent of the
 * in-app guard.
 */
export class InstallationPatchGuardConflict extends Error {
  readonly expectedCurrentDeploymentId: string | null;
  readonly actualCurrentDeploymentId: string | null;
  constructor(input: {
    readonly id: string;
    readonly expectedCurrentDeploymentId: string | null;
    readonly actualCurrentDeploymentId: string | null;
  }) {
    super(
      `installation ${input.id} currentDeploymentId guard lost the race: ` +
        `expected ${input.expectedCurrentDeploymentId ?? "<none>"} but row ` +
        `is now ${input.actualCurrentDeploymentId ?? "<none>"}`,
    );
    this.name = "InstallationPatchGuardConflict";
    this.expectedCurrentDeploymentId = input.expectedCurrentDeploymentId;
    this.actualCurrentDeploymentId = input.actualCurrentDeploymentId;
  }
}

export interface InstallationStore {
  put(installation: Installation): Promise<Installation>;
  get(id: string): Promise<Installation | undefined>;
  list(spaceId?: string): Promise<readonly Installation[]>;
  /**
   * Update an existing Installation's mutable columns. Returns the updated row,
   * or `undefined` when the row does not exist (mirrors the in-memory contract).
   *
   * When `guard` is supplied the update is fenced: it only applies if the row's
   * `current_deployment_id` still equals `guard.currentDeploymentId`. A row that
   * exists but no longer matches the guard throws
   * {@link InstallationPatchGuardConflict}; a row that vanished returns
   * `undefined`. Stores with no durable backend (in-memory) implement the same
   * observable behavior in-process.
   */
  patch(
    id: string,
    patch: Partial<Pick<Installation, "currentDeploymentId" | "status">>,
    guard?: InstallationPatchGuard,
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

export interface PublicationPathClaim {
  readonly spaceId: string;
  readonly path: string;
  readonly installationId: string;
  readonly deploymentId: string;
  readonly publishName: string;
  readonly updatedAt: number;
  readonly leaseExpiresAt?: number;
}

export interface PublicationPathStore {
  claim(claim: PublicationPathClaim): Promise<PublicationPathClaim>;
  list(spaceId: string): Promise<readonly PublicationPathClaim[]>;
}

export class InMemoryInstallationStore implements InstallationStore {
  readonly #rows = new Map<string, Installation>();

  constructor() {
    maybeWarnInMemoryStore("InMemoryInstallationStore");
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
    guard?: InstallationPatchGuard,
  ): Promise<Installation | undefined> {
    const existing = this.#rows.get(id);
    if (!existing) return Promise.resolve(undefined);
    // Mirror the SQL store's compare-and-set semantics in-process so the
    // guard's observable contract is identical across stores.
    if (
      guard !== undefined &&
      existing.currentDeploymentId !== guard.currentDeploymentId
    ) {
      return Promise.reject(
        new InstallationPatchGuardConflict({
          id,
          expectedCurrentDeploymentId: guard.currentDeploymentId,
          actualCurrentDeploymentId: existing.currentDeploymentId,
        }),
      );
    }
    const updated: Installation = { ...existing, ...patch };
    this.#rows.set(id, updated);
    return Promise.resolve(updated);
  }
}

export class InMemoryDeploymentStore implements DeploymentStore {
  readonly #rows = new Map<string, Deployment>();
  readonly #rollbackEvents: RollbackEvent[] = [];

  constructor() {
    maybeWarnInMemoryStore("InMemoryDeploymentStore");
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

export class InMemoryPublicationPathStore implements PublicationPathStore {
  readonly #rows = new Map<string, PublicationPathClaim>();

  constructor() {
    maybeWarnInMemoryStore("InMemoryPublicationPathStore");
  }

  claim(claim: PublicationPathClaim): Promise<PublicationPathClaim> {
    const stored = Object.freeze({ ...claim });
    this.#rows.set(publicationPathKey(claim.spaceId, claim.path), stored);
    return Promise.resolve(stored);
  }

  list(spaceId: string): Promise<readonly PublicationPathClaim[]> {
    return Promise.resolve(
      Array.from(this.#rows.values()).filter((row) =>
        row.spaceId === spaceId
      ),
    );
  }
}

function publicationPathKey(spaceId: string, path: string): string {
  return `${spaceId}:${path}`;
}
