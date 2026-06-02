/**
 * SQL-backed persistence for the public Installer API's Installation +
 * Deployment ledger.
 *
 * Installation and Deployment are the two space durable public concepts of
 * Takosumi (see AGENTS.md). The in-memory stores in `./store.ts` lose the
 * entire ledger on process restart / Cloudflare isolate recycle, which is
 * acceptable only for dev / test. These SQL-backed stores let an operator
 * inject a durable ledger so a redeploy / rollback after a restart can still
 * resolve prior Installations and Deployments.
 *
 * Backing tables (migration `deploy.installer_ledger.create`, version 27):
 *   - `takosumi_installer_installations`
 *   - `takosumi_installer_deployments`
 *   - `takosumi_installer_rollback_events`
 *
 * The Deployment table name is deliberately suffixed with `_installer` so it
 * does NOT collide with the deploy-domain `takosumi_deployments` table, which
 * stores a different record shape (`TakosumiDeploymentRecord`). Conflating the
 * two ledgers would corrupt either one.
 *
 * Redaction note: the pipeline (`./mod.ts`) already runs
 * `materialToDeploymentOutput` / `redactSensitiveOutputs` over
 * `Deployment.outputs` before calling `put`, so the SQL write path persists
 * the already-redacted structure. No additional redaction is applied here so
 * the SQL and in-memory stores stay byte-for-byte equivalent.
 */
import type { Deployment, Installation } from "takosumi-contract/installer-api";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
} from "../../adapters/storage/sql.ts";
import type {
  DeploymentStore,
  InstallationPatchGuard,
  InstallationStore,
  RollbackEvent,
} from "./store.ts";
import { InstallationPatchGuardConflict } from "./store.ts";

export class SqlInstallationStore implements InstallationStore {
  readonly #client: SqlClient;

  constructor(input: { readonly client: SqlClient }) {
    this.#client = input.client;
  }

  async put(installation: Installation): Promise<Installation> {
    const sql = "insert into takosumi_installer_installations " +
      "(id, space_id, app_id, current_deployment_id, status, created_at) " +
      "values ($1, $2, $3, $4, $5, $6) " +
      "on conflict (id) do update set " +
      "space_id = excluded.space_id, " +
      "app_id = excluded.app_id, " +
      "current_deployment_id = excluded.current_deployment_id, " +
      "status = excluded.status, " +
      "created_at = excluded.created_at " +
      "returning id, space_id, app_id, current_deployment_id, status, created_at";
    const result = await this.#query<InstallationRow>(sql, [
      installation.id,
      installation.spaceId,
      installation.appId,
      installation.currentDeploymentId,
      installation.status,
      installation.createdAt,
    ]);
    const row = result.rows[0];
    // `put` mirrors the in-memory contract: the returned value is the row we
    // just wrote. Fall back to the input when the driver omits RETURNING.
    return row ? rowToInstallation(row) : installation;
  }

  async get(id: string): Promise<Installation | undefined> {
    const result = await this.#query<InstallationRow>(
      "select id, space_id, app_id, current_deployment_id, status, created_at " +
        "from takosumi_installer_installations where id = $1",
      [id],
    );
    const row = result.rows[0];
    return row ? rowToInstallation(row) : undefined;
  }

  async list(spaceId?: string): Promise<readonly Installation[]> {
    const result = spaceId === undefined
      ? await this.#query<InstallationRow>(
        "select id, space_id, app_id, current_deployment_id, status, created_at " +
          "from takosumi_installer_installations order by created_at asc",
      )
      : await this.#query<InstallationRow>(
        "select id, space_id, app_id, current_deployment_id, status, created_at " +
          "from takosumi_installer_installations where space_id = $1 " +
          "order by created_at asc",
        [spaceId],
      );
    return result.rows.map(rowToInstallation);
  }

  async patch(
    id: string,
    patch: Partial<Pick<Installation, "currentDeploymentId" | "status">>,
    guard?: InstallationPatchGuard,
  ): Promise<Installation | undefined> {
    // Mirror the in-memory contract: a patch against a missing row returns
    // undefined rather than inserting. We compute the column list dynamically
    // so an empty patch is a no-op update that still returns the current row.
    const sets: string[] = [];
    const params: (string | null)[] = [id];
    if ("currentDeploymentId" in patch) {
      params.push(patch.currentDeploymentId ?? null);
      sets.push(`current_deployment_id = $${params.length}`);
    }
    if ("status" in patch) {
      params.push(patch.status ?? null);
      sets.push(`status = $${params.length}`);
    }
    if (sets.length === 0) {
      return await this.get(id);
    }
    // Optimistic-concurrency fence: when the caller supplies a pre-read
    // `currentDeploymentId` guard, only match the row whose pointer still
    // equals it, turning the dry-run → apply `expected.currentDeploymentId`
    // TOCTOU guard into an atomic compare-and-set at the durable store. We use
    // `IS NOT DISTINCT FROM` rather than `=` so the nullable initial pointer
    // (fresh-install transition from null) matches correctly. When no guard is
    // supplied the update stays unconditional — behavior-compatible with
    // callers that do not fence (installationApply, rollback).
    let whereClause = "where id = $1";
    if (guard !== undefined) {
      params.push(guard.currentDeploymentId ?? null);
      whereClause +=
        ` and current_deployment_id is not distinct from $${params.length}`;
    }
    const result = await this.#query<InstallationRow>(
      `update takosumi_installer_installations set ${sets.join(", ")} ` +
        whereClause + " " +
        "returning id, space_id, app_id, current_deployment_id, status, created_at",
      params,
    );
    const row = result.rows[0];
    if (row) return rowToInstallation(row);
    if (guard === undefined) {
      // No fence: a 0-row result means the row does not exist.
      return undefined;
    }
    // Guarded 0-row result: distinguish "row vanished" (return undefined,
    // matching the unguarded missing-row contract) from "row exists but the
    // pointer advanced" (the guard lost the race) so a concurrent deploy that
    // moved the pointer surfaces a fail-fast conflict instead of being
    // mis-reported as a missing row.
    const current = await this.get(id);
    if (current === undefined) return undefined;
    throw new InstallationPatchGuardConflict({
      id,
      expectedCurrentDeploymentId: guard.currentDeploymentId,
      actualCurrentDeploymentId: current.currentDeploymentId,
    });
  }

  #query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    return this.#client.query<Row>(sql, parameters);
  }
}

export class SqlDeploymentStore implements DeploymentStore {
  readonly #client: SqlClient;
  readonly #idFactory: () => string;

  constructor(
    input: { readonly client: SqlClient; readonly idFactory?: () => string },
  ) {
    this.#client = input.client;
    this.#idFactory = input.idFactory ?? (() => crypto.randomUUID());
  }

  async put(deployment: Deployment): Promise<Deployment> {
    const sql = "insert into takosumi_installer_deployments " +
      "(id, installation_id, source_json, source_digest, artifact_digest, plan_snapshot_digest, plan_snapshot_json, bindings_snapshot_json, status, outputs_json, created_at) " +
      "values ($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11) " +
      "on conflict (id) do update set " +
      "installation_id = excluded.installation_id, " +
      "source_json = excluded.source_json, " +
      "source_digest = excluded.source_digest, " +
      "artifact_digest = excluded.artifact_digest, " +
      "plan_snapshot_digest = excluded.plan_snapshot_digest, " +
      "plan_snapshot_json = excluded.plan_snapshot_json, " +
      "bindings_snapshot_json = excluded.bindings_snapshot_json, " +
      "status = excluded.status, " +
      "outputs_json = excluded.outputs_json, " +
      "created_at = excluded.created_at " +
      "returning id, installation_id, source_json, source_digest, artifact_digest, plan_snapshot_digest, plan_snapshot_json, bindings_snapshot_json, status, outputs_json, created_at";
    const result = await this.#query<DeploymentRow>(sql, [
      deployment.id,
      deployment.installationId,
      JSON.stringify(deployment.source),
      deployment.sourceDigest ?? null,
      deployment.artifactDigest ?? null,
      deployment.planSnapshotDigest,
      JSON.stringify(deployment.planSnapshot),
      JSON.stringify(deployment.bindingsSnapshot),
      deployment.status,
      JSON.stringify(deployment.outputs),
      deployment.createdAt,
    ]);
    const row = result.rows[0];
    return row ? rowToDeployment(row) : deployment;
  }

  async get(id: string): Promise<Deployment | undefined> {
    const result = await this.#query<DeploymentRow>(
      "select id, installation_id, source_json, source_digest, artifact_digest, plan_snapshot_digest, plan_snapshot_json, bindings_snapshot_json, status, outputs_json, created_at " +
        "from takosumi_installer_deployments where id = $1",
      [id],
    );
    const row = result.rows[0];
    return row ? rowToDeployment(row) : undefined;
  }

  async listForInstallation(
    installationId: string,
  ): Promise<readonly Deployment[]> {
    const result = await this.#query<DeploymentRow>(
      "select id, installation_id, source_json, source_digest, artifact_digest, plan_snapshot_digest, plan_snapshot_json, bindings_snapshot_json, status, outputs_json, created_at " +
        "from takosumi_installer_deployments where installation_id = $1 " +
        "order by created_at asc",
      [installationId],
    );
    return result.rows.map(rowToDeployment);
  }

  async recordRollback(event: RollbackEvent): Promise<void> {
    await this.#query(
      "insert into takosumi_installer_rollback_events " +
        "(id, installation_id, rolled_back_from, rolled_back_to, created_at) " +
        "values ($1, $2, $3, $4, $5)",
      [
        this.#idFactory(),
        event.installationId,
        event.rolledBackFrom,
        event.rolledBackTo,
        event.createdAt,
      ],
    );
  }

  async listRollbackEvents(
    installationId: string,
  ): Promise<readonly RollbackEvent[]> {
    const result = await this.#query<RollbackEventRow>(
      "select installation_id, rolled_back_from, rolled_back_to, created_at " +
        "from takosumi_installer_rollback_events where installation_id = $1 " +
        "order by created_at asc",
      [installationId],
    );
    return result.rows.map(rowToRollbackEvent);
  }

  #query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    return this.#client.query<Row>(sql, parameters);
  }
}

interface InstallationRow extends Record<string, unknown> {
  readonly id: string;
  readonly space_id: string;
  readonly app_id: string;
  readonly current_deployment_id: string | null;
  readonly status: string;
  readonly created_at: number | string;
}

interface DeploymentRow extends Record<string, unknown> {
  readonly id: string;
  readonly installation_id: string;
  readonly source_json: unknown;
  readonly source_digest: string | null;
  readonly artifact_digest: string | null;
  readonly plan_snapshot_digest: string;
  readonly plan_snapshot_json: unknown;
  readonly bindings_snapshot_json: unknown;
  readonly status: string;
  readonly outputs_json: unknown;
  readonly created_at: number | string;
}

interface RollbackEventRow extends Record<string, unknown> {
  readonly installation_id: string;
  readonly rolled_back_from: string | null;
  readonly rolled_back_to: string;
  readonly created_at: number | string;
}

function rowToInstallation(row: InstallationRow): Installation {
  return {
    id: row.id,
    spaceId: row.space_id,
    appId: row.app_id,
    currentDeploymentId: row.current_deployment_id,
    status: row.status as Installation["status"],
    createdAt: toEpochMillis(row.created_at),
  };
}

function rowToDeployment(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    installationId: row.installation_id,
    source: parseJson(row.source_json) as Deployment["source"],
    ...(row.source_digest ? { sourceDigest: row.source_digest } : {}),
    ...(row.artifact_digest ? { artifactDigest: row.artifact_digest } : {}),
    planSnapshotDigest: row.plan_snapshot_digest,
    planSnapshot: parseJson(row.plan_snapshot_json) as Deployment["planSnapshot"],
    bindingsSnapshot: (parseJson(row.bindings_snapshot_json) ?? []) as Deployment[
      "bindingsSnapshot"
    ],
    status: row.status as Deployment["status"],
    outputs: (parseJson(row.outputs_json) ?? {}) as Deployment["outputs"],
    createdAt: toEpochMillis(row.created_at),
  };
}

function rowToRollbackEvent(row: RollbackEventRow): RollbackEvent {
  return {
    installationId: row.installation_id,
    rolledBackFrom: row.rolled_back_from,
    rolledBackTo: row.rolled_back_to,
    createdAt: toEpochMillis(row.created_at),
  };
}

/**
 * Postgres `jsonb` columns deserialize to parsed JS objects via node-pg;
 * Cloudflare D1 / sqlite drivers return TEXT, which must be `JSON.parse`d.
 * Accept both shapes so the store works against any compatible driver.
 */
function parseJson(value: unknown): unknown {
  if (typeof value === "string") {
    if (value === "") return null;
    return JSON.parse(value);
  }
  return value;
}

/**
 * `createdAt` is an epoch-millis number on the contract type. Postgres
 * `bigint` round-trips as a string under node-pg, while D1 / sqlite returns a
 * number; accept both so the store preserves the numeric contract.
 */
function toEpochMillis(value: number | string): number {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `takosumi installer ledger created_at is not numeric: ${value}`,
    );
  }
  return parsed;
}
