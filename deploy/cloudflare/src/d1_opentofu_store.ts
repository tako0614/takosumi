import type {
  ApplyRun,
  Deployment,
  Installation,
  PlanRun,
  RunnerProfile,
} from "../../../src/contract/deploy-control-api.ts";
import type {
  InstallationPatchGuard,
  OpenTofuDeploymentStore,
} from "../../../src/service/domains/deploy-control/store.ts";
import { InstallationPatchGuardConflict } from "../../../src/service/domains/deploy-control/store.ts";
import type { D1Database } from "./bindings.ts";

const TABLE = "takosumi_cf_opentofu_ledger";

type Namespace =
  | "runner-profile"
  | "plan-run"
  | "apply-run"
  | "installation"
  | "deployment";

export class CloudflareD1OpenTofuDeploymentStore
  implements OpenTofuDeploymentStore {
  #initialized?: Promise<void>;

  constructor(private readonly db: D1Database) {}

  async putRunnerProfile(profile: RunnerProfile): Promise<RunnerProfile> {
    await this.#put("runner-profile", profile.id, profile, {
      createdAt: profile.createdAt,
      updatedAt: profile.createdAt,
    });
    return profile;
  }

  async getRunnerProfile(id: string): Promise<RunnerProfile | undefined> {
    return await this.#get("runner-profile", id);
  }

  async listRunnerProfiles(): Promise<readonly RunnerProfile[]> {
    return await this.#list<RunnerProfile>("runner-profile");
  }

  async putPlanRun(run: PlanRun): Promise<PlanRun> {
    await this.#put("plan-run", run.id, run, {
      spaceId: run.spaceId,
      installationId: run.installationId,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    });
    return run;
  }

  async getPlanRun(id: string): Promise<PlanRun | undefined> {
    return await this.#get("plan-run", id);
  }

  async putApplyRun(run: ApplyRun): Promise<ApplyRun> {
    await this.#put("apply-run", run.id, run, {
      spaceId: run.spaceId,
      installationId: run.installationId,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    });
    return run;
  }

  async getApplyRun(id: string): Promise<ApplyRun | undefined> {
    return await this.#get("apply-run", id);
  }

  async putInstallation(installation: Installation): Promise<Installation> {
    await this.#put("installation", installation.id, installation, {
      spaceId: installation.spaceId,
      installationId: installation.id,
      status: installation.status,
      createdAt: installation.createdAt,
      updatedAt: installation.updatedAt,
    });
    return installation;
  }

  async getInstallation(id: string): Promise<Installation | undefined> {
    return await this.#get("installation", id);
  }

  async listInstallations(spaceId?: string): Promise<readonly Installation[]> {
    return await this.#list<Installation>("installation", { spaceId });
  }

  async patchInstallation(
    id: string,
    patch: Partial<
      Pick<
        Installation,
        | "currentDeploymentId"
        | "status"
        | "updatedAt"
        | "runnerProfileId"
        | "source"
      >
    >,
    guard?: InstallationPatchGuard,
  ): Promise<Installation | undefined> {
    const existing = await this.getInstallation(id);
    if (!existing) return undefined;
    if (
      guard !== undefined &&
      (existing.currentDeploymentId !== guard.currentDeploymentId ||
        (guard.status !== undefined && existing.status !== guard.status))
    ) {
      throw new InstallationPatchGuardConflict({
        id,
        expectedCurrentDeploymentId: guard.currentDeploymentId,
        actualCurrentDeploymentId: existing.currentDeploymentId,
        expectedStatus: guard.status,
        actualStatus: existing.status,
      });
    }
    const updated: Installation = { ...existing, ...patch };
    if (!guard) return await this.putInstallation(updated);
    await this.#ensureSchema();
    const result = await this.db.prepare(
      `update ${TABLE} set
        space_id = ?,
        installation_id = ?,
        status = ?,
        record_json = ?,
        created_at = ?,
        updated_at = ?
       where namespace = ?
         and key = ?
         and json_extract(record_json, '$.currentDeploymentId') is ?
         and (? is null or status = ?)`,
    ).bind(
      updated.spaceId,
      updated.id,
      updated.status,
      JSON.stringify(updated),
      updated.createdAt,
      updated.updatedAt,
      "installation",
      id,
      guard.currentDeploymentId,
      guard.status ?? null,
      guard.status ?? null,
    ).run();
    if ((result.meta?.changes ?? 0) > 0) return updated;
    const actual = await this.getInstallation(id);
    if (!actual) return undefined;
    throw new InstallationPatchGuardConflict({
      id,
      expectedCurrentDeploymentId: guard.currentDeploymentId,
      actualCurrentDeploymentId: actual.currentDeploymentId,
      expectedStatus: guard.status,
      actualStatus: actual.status,
    });
  }

  async putDeployment(deployment: Deployment): Promise<Deployment> {
    await this.#put("deployment", deployment.id, deployment, {
      spaceId: undefined,
      installationId: deployment.installationId,
      status: deployment.status,
      createdAt: deployment.createdAt,
      updatedAt: deployment.completedAt ?? deployment.createdAt,
    });
    return deployment;
  }

  async getDeployment(id: string): Promise<Deployment | undefined> {
    return await this.#get("deployment", id);
  }

  async listDeployments(
    installationId: string,
  ): Promise<readonly Deployment[]> {
    return await this.#list<Deployment>("deployment", { installationId });
  }

  async #put(
    namespace: Namespace,
    key: string,
    record: unknown,
    metadata: {
      readonly spaceId?: string;
      readonly installationId?: string;
      readonly status?: string;
      readonly createdAt: number;
      readonly updatedAt: number;
    },
  ): Promise<void> {
    await this.#ensureSchema();
    await this.db.prepare(
      `insert into ${TABLE}
        (namespace, key, space_id, installation_id, status, record_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (namespace, key) do update set
        space_id = excluded.space_id,
        installation_id = excluded.installation_id,
        status = excluded.status,
        record_json = excluded.record_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
    ).bind(
      namespace,
      key,
      metadata.spaceId ?? null,
      metadata.installationId ?? null,
      metadata.status ?? null,
      JSON.stringify(record),
      metadata.createdAt,
      metadata.updatedAt,
    ).run();
  }

  async #get<T>(namespace: Namespace, key: string): Promise<T | undefined> {
    await this.#ensureSchema();
    const row = await this.db.prepare(
      `select record_json from ${TABLE} where namespace = ? and key = ?`,
    ).bind(namespace, key).first<{ record_json: string }>();
    return row ? JSON.parse(row.record_json) as T : undefined;
  }

  async #list<T>(
    namespace: Namespace,
    filter: {
      readonly spaceId?: string;
      readonly installationId?: string;
    } = {},
  ): Promise<readonly T[]> {
    await this.#ensureSchema();
    if (filter.spaceId !== undefined) {
      const result = await this.db.prepare(
        `select record_json from ${TABLE}
         where namespace = ? and space_id = ?
         order by created_at asc, key asc`,
      ).bind(namespace, filter.spaceId).all<{ record_json: string }>();
      return (result.results ?? []).map((row) =>
        JSON.parse(row.record_json) as T
      );
    }
    if (filter.installationId !== undefined) {
      const result = await this.db.prepare(
        `select record_json from ${TABLE}
         where namespace = ? and installation_id = ?
         order by created_at asc, key asc`,
      ).bind(namespace, filter.installationId).all<{ record_json: string }>();
      return (result.results ?? []).map((row) =>
        JSON.parse(row.record_json) as T
      );
    }
    const result = await this.db.prepare(
      `select record_json from ${TABLE}
       where namespace = ?
       order by created_at asc, key asc`,
    ).bind(namespace).all<{ record_json: string }>();
    return (result.results ?? []).map((row) => JSON.parse(row.record_json) as T);
  }

  async #ensureSchema(): Promise<void> {
    this.#initialized ??= ensureD1OpenTofuLedgerSchema(this.db);
    await this.#initialized;
  }
}

export function createCloudflareD1OpenTofuDeploymentStore(
  db: D1Database,
): OpenTofuDeploymentStore {
  return new CloudflareD1OpenTofuDeploymentStore(db);
}

export async function ensureD1OpenTofuLedgerSchema(
  db: D1Database,
): Promise<void> {
  await db.prepare(
    `create table if not exists ${TABLE} (
      namespace text not null,
      key text not null,
      space_id text,
      installation_id text,
      status text,
      record_json text not null,
      created_at integer not null,
      updated_at integer not null,
      primary key (namespace, key)
    )`,
  ).run();
  await db.prepare(
    `create index if not exists ${TABLE}_space_idx
      on ${TABLE} (namespace, space_id, created_at)`,
  ).run();
  await db.prepare(
    `create index if not exists ${TABLE}_installation_idx
      on ${TABLE} (namespace, installation_id, created_at)`,
  ).run();
  await db.prepare(
    `create index if not exists ${TABLE}_status_idx
      on ${TABLE} (namespace, status, updated_at)`,
  ).run();
}
