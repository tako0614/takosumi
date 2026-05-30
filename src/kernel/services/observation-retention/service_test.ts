import assert from "node:assert/strict";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
} from "../../adapters/storage/sql.ts";
import {
  DEFAULT_OBSERVATION_RETENTION_POLICY,
  ObservationRetentionService,
  startObservationRetentionJob,
} from "./service.ts";

interface ProviderObservationRow {
  id: string;
  deployment_id: string;
  observed_at: string; // ISO
  archived: boolean;
}

interface RuntimeObservationRow {
  id: string;
  materialization_id: string;
  observed_at: string;
  archived: boolean;
}

interface GroupHeadRow {
  space_id: string;
  group_id: string;
  current_deployment_id: string;
}

class FakeObservationSqlClient implements SqlClient {
  readonly providerObservations: ProviderObservationRow[] = [];
  readonly runtimeObservations: RuntimeObservationRow[] = [];
  readonly groupHeads: GroupHeadRow[] = [];

  query<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    const normalized = sql.trim().toLowerCase();
    const params = (parameters ?? {}) as Record<string, unknown>;
    const cutoff = String(params.cutoff ?? "");
    if (normalized.startsWith("update provider_observations")) {
      const currentIds = new Set(
        this.groupHeads.map((h) => h.current_deployment_id),
      );
      let count = 0;
      for (const row of this.providerObservations) {
        if (
          !row.archived && row.observed_at < cutoff &&
          !currentIds.has(row.deployment_id)
        ) {
          row.archived = true;
          count++;
        }
      }
      return Promise.resolve({ rows: [], rowCount: count } as SqlQueryResult<
        Row
      >);
    }
    if (normalized.startsWith("update runtime_provider_observations")) {
      let count = 0;
      for (const row of this.runtimeObservations) {
        if (!row.archived && row.observed_at < cutoff) {
          row.archived = true;
          count++;
        }
      }
      return Promise.resolve({ rows: [], rowCount: count } as SqlQueryResult<
        Row
      >);
    }
    if (normalized.startsWith("delete from provider_observations")) {
      const before = this.providerObservations.length;
      const remaining = this.providerObservations.filter(
        (row) => !(row.archived && row.observed_at < cutoff),
      );
      this.providerObservations.length = 0;
      this.providerObservations.push(...remaining);
      return Promise.resolve(
        { rows: [], rowCount: before - remaining.length } as SqlQueryResult<
          Row
        >,
      );
    }
    if (normalized.startsWith("delete from runtime_provider_observations")) {
      const before = this.runtimeObservations.length;
      const remaining = this.runtimeObservations.filter(
        (row) => !(row.archived && row.observed_at < cutoff),
      );
      this.runtimeObservations.length = 0;
      this.runtimeObservations.push(...remaining);
      return Promise.resolve(
        { rows: [], rowCount: before - remaining.length } as SqlQueryResult<
          Row
        >,
      );
    }
    throw new Error(`unhandled SQL: ${normalized}`);
  }
}

const REFERENCE_NOW = new Date("2026-04-30T00:00:00.000Z");
function isoDaysAgo(days: number): string {
  return new Date(REFERENCE_NOW.getTime() - days * 86_400_000).toISOString();
}

Deno.test("ObservationRetentionService archives rows older than 30 days", async () => {
  const client = new FakeObservationSqlClient();
  client.providerObservations.push(
    {
      id: "obs_recent",
      deployment_id: "dep_old",
      observed_at: isoDaysAgo(5),
      archived: false,
    },
    {
      id: "obs_stale",
      deployment_id: "dep_old",
      observed_at: isoDaysAgo(40),
      archived: false,
    },
  );
  const service = new ObservationRetentionService({
    client,
    clock: () => REFERENCE_NOW,
  });

  const report = await service.run();

  assert.equal(report.archivedDeploy, 1);
  assert.equal(report.deletedDeploy, 0);
  assert.equal(
    client.providerObservations.find((row) => row.id === "obs_recent")
      ?.archived,
    false,
  );
  assert.equal(
    client.providerObservations.find((row) => row.id === "obs_stale")?.archived,
    true,
  );
});

Deno.test("ObservationRetentionService deletes archived rows past the 90d cap", async () => {
  const client = new FakeObservationSqlClient();
  client.providerObservations.push(
    {
      id: "obs_archived_recent",
      deployment_id: "dep_old",
      observed_at: isoDaysAgo(60),
      archived: true,
    },
    {
      id: "obs_archived_capped",
      deployment_id: "dep_old",
      observed_at: isoDaysAgo(120),
      archived: true,
    },
    {
      id: "obs_live",
      deployment_id: "dep_old",
      observed_at: isoDaysAgo(2),
      archived: false,
    },
  );
  const service = new ObservationRetentionService({
    client,
    clock: () => REFERENCE_NOW,
  });

  const report = await service.run();

  assert.equal(report.deletedDeploy, 1);
  assert.deepEqual(
    client.providerObservations.map((row) => row.id).sort(),
    ["obs_archived_recent", "obs_live"],
  );
});

Deno.test("ObservationRetentionService never archives observations of the current deployment", async () => {
  const client = new FakeObservationSqlClient();
  client.groupHeads.push({
    space_id: "space_a",
    group_id: "group_a",
    current_deployment_id: "dep_current",
  });
  client.providerObservations.push(
    {
      id: "obs_current",
      deployment_id: "dep_current",
      observed_at: isoDaysAgo(50),
      archived: false,
    },
    {
      id: "obs_old_deploy",
      deployment_id: "dep_old",
      observed_at: isoDaysAgo(50),
      archived: false,
    },
  );
  const service = new ObservationRetentionService({
    client,
    clock: () => REFERENCE_NOW,
  });

  const report = await service.run();

  assert.equal(report.archivedDeploy, 1);
  assert.equal(
    client.providerObservations.find((row) => row.id === "obs_current")
      ?.archived,
    false,
  );
  assert.equal(
    client.providerObservations.find((row) => row.id === "obs_old_deploy")
      ?.archived,
    true,
  );
});

Deno.test("ObservationRetentionService archives runtime observations independently", async () => {
  const client = new FakeObservationSqlClient();
  client.runtimeObservations.push(
    {
      id: "rto_recent",
      materialization_id: "mat_a",
      observed_at: isoDaysAgo(7),
      archived: false,
    },
    {
      id: "rto_old",
      materialization_id: "mat_a",
      observed_at: isoDaysAgo(45),
      archived: false,
    },
    {
      id: "rto_capped",
      materialization_id: "mat_a",
      observed_at: isoDaysAgo(120),
      archived: true,
    },
  );
  const service = new ObservationRetentionService({
    client,
    clock: () => REFERENCE_NOW,
  });

  const report = await service.run();

  assert.equal(report.archivedRuntime, 1);
  assert.equal(report.deletedRuntime, 1);
  assert.equal(
    client.runtimeObservations.find((row) => row.id === "rto_recent")?.archived,
    false,
  );
  assert.equal(
    client.runtimeObservations.find((row) => row.id === "rto_old")?.archived,
    true,
  );
  assert.equal(
    client.runtimeObservations.some((row) => row.id === "rto_capped"),
    false,
  );
});

Deno.test("ObservationRetentionService is idempotent", async () => {
  const client = new FakeObservationSqlClient();
  client.providerObservations.push({
    id: "obs",
    deployment_id: "dep",
    observed_at: isoDaysAgo(40),
    archived: false,
  });
  const service = new ObservationRetentionService({
    client,
    clock: () => REFERENCE_NOW,
  });

  const first = await service.run();
  const second = await service.run();

  assert.equal(first.archivedDeploy, 1);
  assert.equal(second.archivedDeploy, 0);
  assert.equal(second.deletedDeploy, 0);
});

Deno.test("ObservationRetentionService rejects invalid policy", () => {
  const client = new FakeObservationSqlClient();
  assert.throws(
    () =>
      new ObservationRetentionService({
        client,
        policy: { recentRetentionDays: 90, archiveCapDays: 30 },
      }),
    /archiveCapDays must be greater than recentRetentionDays/,
  );
});

Deno.test("ObservationRetentionService default policy uses 30d / 90d", () => {
  assert.equal(DEFAULT_OBSERVATION_RETENTION_POLICY.recentRetentionDays, 30);
  assert.equal(DEFAULT_OBSERVATION_RETENTION_POLICY.archiveCapDays, 90);
});

Deno.test("startObservationRetentionJob runs immediately and stops cleanly", async () => {
  const client = new FakeObservationSqlClient();
  client.providerObservations.push({
    id: "obs_old",
    deployment_id: "dep",
    observed_at: isoDaysAgo(60),
    archived: false,
  });
  const service = new ObservationRetentionService({
    client,
    clock: () => REFERENCE_NOW,
  });
  const reports: number[] = [];
  const handle = startObservationRetentionJob({
    service,
    intervalMs: 60_000,
    onReport: (report) => reports.push(report.archivedDeploy),
  });
  await handle.stop();
  assert.equal(reports.length, 1);
  assert.equal(reports[0], 1);
});

Deno.test("ObservationRetentionService tolerates missing relations", async () => {
  const client: SqlClient = {
    query<Row extends Record<string, unknown>>(): Promise<
      SqlQueryResult<Row>
    > {
      const error = new Error(
        'relation "provider_observations" does not exist',
      );
      (error as { code?: string }).code = "42P01";
      throw error;
    },
  };
  const service = new ObservationRetentionService({
    client,
    clock: () => REFERENCE_NOW,
  });
  const report = await service.run();
  assert.equal(report.archivedDeploy, 0);
  assert.equal(report.deletedDeploy, 0);
  assert.equal(report.archivedRuntime, 0);
  assert.equal(report.deletedRuntime, 0);
});
