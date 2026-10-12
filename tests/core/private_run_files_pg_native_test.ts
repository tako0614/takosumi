import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { PartitionedSecretBoundaryCrypto } from "../../core/adapters/secret-store/memory.ts";
import { StorageMigrationRunner } from "../../core/adapters/storage/migration-runner/mod.ts";
import type {
  SqlClient,
  SqlTransaction,
} from "../../core/adapters/storage/sql.ts";
import {
  PrivateRunFilesService,
  type PrivateRunFileScope,
} from "../../core/domains/private-run-files/mod.ts";
import { PostgresPrivateRunFileRepository } from "../../core/domains/private-run-files/repository_sql.ts";
import { createLocalPrivateRunFileBlobStore } from "../../deploy/node-postgres/src/local-private-run-file-blob-store.ts";

const enabled = process.env.TAKOSUMI_TEST_NATIVE_POSTGRES_RESTART === "1";
const dataRoot = "/dev/shm/t";
const maxBytes = 1024;

test.skipIf(!enabled)(
  "private Run files persist through real PostgreSQL commit races and daemon restart",
  async () => {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const blobRoot = await mkdtemp(
      join(dataRoot, "takosumi-private-run-files-blobs-"),
    );
    let database: { close(): Promise<void> } | undefined;
    const closers: Array<() => Promise<void>> = [];

    try {
      const {
        createNativePostgresRestartContainer,
        openNativePostgresSqlClient,
      } = await import("../helpers/deploy-control/native_postgres_restart.ts");
      const fixture = await createNativePostgresRestartContainer({ dataRoot });
      database = fixture;
      expect(fixture.dataDirectory.startsWith(`${dataRoot}/`)).toBe(true);
      let sql = await openNativePostgresSqlClient(fixture.databaseUrl);
      const closeBeforeRestart = () => sql.close();
      closers.push(closeBeforeRestart);
      await new StorageMigrationRunner(sql.client).applyPending();
      const scope: PrivateRunFileScope = {
        workspaceId: `workspace_${crypto.randomUUID()}`,
        capsuleId: `capsule_${crypto.randomUUID()}`,
        environment: "native-test",
        slot: "opaque-private-run-file-slot",
      };
      const runId = `run_${crypto.randomUUID()}`;
      const leaseToken = `lease_${crypto.randomUUID()}`;
      const epoch = 1;
      await seedAuthority(sql.client, scope, runId, leaseToken);

      const cryptoBoundary = new PartitionedSecretBoundaryCrypto({
        globalPassphrase: "native-private-run-file-test-key-material-0001",
      });
      const blobs = createLocalPrivateRunFileBlobStore({
        root: blobRoot,
        maxBytes,
        cryptoBoundary,
      });
      const authorization = { authorize: async () => {} };
      const serviceFor = (client: SqlClient) =>
        new PrivateRunFilesService({
          authorization,
          repository: new PostgresPrivateRunFileRepository(client),
          blobs,
          maxBytes,
        });
      const authority = { runId, executionAuthorityEpoch: epoch, leaseToken };
      let service = serviceFor(sql.client);

      await expect(service.read({ scope, authority })).resolves.toEqual({
        kind: "absent",
      });

      const initialBytes = new TextEncoder().encode("durable private bytes");
      const first = await service.commit({
        scope,
        authority,
        expectedVersion: 0,
        commitId: "native-first-commit",
        bytes: initialBytes,
      });
      expect(first.kind).toBe("committed");
      if (first.kind !== "committed")
        throw new Error("initial PostgreSQL commit was not acknowledged");
      await expect(service.read({ scope, authority })).resolves.toMatchObject({
        kind: "present",
        version: 1,
        bytes: initialBytes,
      });
      await expect(
        service.read({
          scope: { ...scope, workspaceId: `${scope.workspaceId}_foreign` },
          authority,
        }),
      ).rejects.toMatchObject({ code: "authorization_rejected" });

      await expect(
        service.commit({
          scope,
          authority,
          expectedVersion: 0,
          commitId: "native-first-commit",
          bytes: initialBytes,
        }),
      ).resolves.toMatchObject({ kind: "replayed", receipt: first.receipt });
      await expect(
        service.commit({
          scope,
          authority,
          expectedVersion: 0,
          commitId: "native-first-commit",
          bytes: new TextEncoder().encode("changed content"),
        }),
      ).resolves.toMatchObject({ kind: "conflict" });

      const contenders = await Promise.all([
        service.commit({
          scope,
          authority,
          expectedVersion: 1,
          commitId: "native-race-left",
          bytes: new TextEncoder().encode("left contender"),
        }),
        service.commit({
          scope,
          authority,
          expectedVersion: 1,
          commitId: "native-race-right",
          bytes: new TextEncoder().encode("right contender"),
        }),
      ]);
      expect(
        contenders.filter((result) => result.kind === "committed"),
      ).toHaveLength(1);
      expect(
        contenders.filter((result) => result.kind === "conflict"),
      ).toHaveLength(1);

      await expect(
        service.commit({
          scope: { ...scope, workspaceId: `${scope.workspaceId}_foreign` },
          authority,
          expectedVersion: 2,
          commitId: "native-foreign-workspace",
          bytes: new TextEncoder().encode("foreign"),
        }),
      ).resolves.toMatchObject({ kind: "authority_rejected" });

      await sql.client.query(
        "update takosumi_workspaces set management_state = 'draining', management_epoch = 2 where id = $1",
        [scope.workspaceId],
      );
      await expect(service.read({ scope, authority })).resolves.toMatchObject({
        kind: "present",
        version: 2,
      });
      await expect(
        service.resolve({
          scope,
          authority,
          commitId: first.receipt.commitId,
          expectedVersion: 0,
          digest: first.receipt.digest,
        }),
      ).resolves.toMatchObject({
        kind: "committed",
        receipt: first.receipt,
      });
      const drainScope = { ...scope, slot: "native-drain-settlement" };
      const drainBytes = new TextEncoder().encode("settled during drain");
      const drainCommit = await service.commit({
        scope: drainScope,
        authority,
        expectedVersion: 0,
        commitId: "native-drain-commit",
        bytes: drainBytes,
      });
      expect(drainCommit.kind).toBe("committed");
      await expect(service.read({ scope: drainScope, authority }))
        .resolves.toMatchObject({
          kind: "present",
          version: 1,
          bytes: drainBytes,
        });
      await sql.client.query(
        "update takosumi_runs set run_json = jsonb_set(run_json, '{workspaceManagementAuthority,managementEpoch}', '2'::jsonb) where id = $1",
        [runId],
      );
      await expect(service.read({ scope, authority })).rejects.toMatchObject({
        code: "authorization_rejected",
      });
      await expect(service.commit({ scope: drainScope, authority,
        expectedVersion: 0, commitId: "native-drain-commit", bytes: drainBytes }))
        .resolves.toMatchObject({ kind: "authority_rejected" });
      await sql.client.query(
        "update takosumi_runs set run_json = jsonb_set(run_json, '{workspaceManagementAuthority,managementEpoch}', '1'::jsonb) where id = $1",
        [runId],
      );
      await sql.client.query(
        "update takosumi_workspaces set management_state = 'frozen' where id = $1",
        [scope.workspaceId],
      );
      await expect(service.read({ scope, authority })).rejects.toMatchObject({
        code: "authorization_rejected",
      });
      await expect(
        service.commit({
          scope: drainScope,
          authority,
          expectedVersion: 0,
          commitId: "native-drain-commit",
          bytes: drainBytes,
        }),
      )
        .resolves.toMatchObject({ kind: "authority_rejected" });
      await sql.client.query(
        "update takosumi_workspaces set management_state = 'active' where id = $1",
        [scope.workspaceId],
      );

      await sql.client.query(
        "update takosumi_capsules set execution_authority_epoch = 2 where id = $1",
        [scope.capsuleId],
      );
      await expect(
        service.commit({
          scope,
          authority,
          expectedVersion: 2,
          commitId: "native-stale-epoch",
          bytes: new TextEncoder().encode("stale epoch"),
        }),
      ).resolves.toMatchObject({ kind: "authority_rejected" });
      await expect(service.read({ scope, authority })).rejects.toMatchObject({
        code: "authorization_rejected",
      });
      await sql.client.query(
        "update takosumi_capsules set execution_authority_epoch = 1 where id = $1",
        [scope.capsuleId],
      );

      await sql.client.query(
        "update takosumi_runs set run_json = jsonb_set(run_json, '{capsuleExecutionAuthorityEpoch}', '2'::jsonb) where id = $1",
        [runId],
      );
      await expect(
        service.commit({
          scope,
          authority,
          expectedVersion: 2,
          commitId: "native-run-captured-stale-epoch",
          bytes: new TextEncoder().encode("captured stale epoch"),
        }),
      ).resolves.toMatchObject({ kind: "authority_rejected" });
      await expect(service.read({ scope, authority })).rejects.toMatchObject({
        code: "authorization_rejected",
      });
      await sql.client.query(
        "update takosumi_runs set run_json = jsonb_set(run_json, '{capsuleExecutionAuthorityEpoch}', '1'::jsonb) where id = $1",
        [runId],
      );

      await sql.client.query(
        "update takosumi_runs set lease_token = $2 where id = $1",
        [runId, "replacement-lease"],
      );
      await expect(
        service.commit({
          scope,
          authority,
          expectedVersion: 2,
          commitId: "native-lost-lease",
          bytes: new TextEncoder().encode("lost lease"),
        }),
      ).resolves.toMatchObject({ kind: "authority_rejected" });
      await expect(service.read({ scope, authority })).rejects.toMatchObject({
        code: "authorization_rejected",
      });
      await sql.client.query(
        "update takosumi_runs set lease_token = $2 where id = $1",
        [runId, leaseToken],
      );

      const uncertainBytes = new TextEncoder().encode(
        "commit survived lost acknowledgement",
      );
      const uncertainClient = withOneLostCommitAcknowledgement(sql.client);
      const uncertainService = serviceFor(uncertainClient);
      const uncertain = await uncertainService.commit({
        scope,
        authority,
        expectedVersion: 2,
        commitId: "native-ack-lost",
        bytes: uncertainBytes,
      });
      expect(uncertain.kind).toBe("unknown");

      await sql.close();
      closers.splice(closers.indexOf(closeBeforeRestart), 1);
      const restartEvidence = await fixture.restartPostgresDaemon();
      expect(restartEvidence.stoppedAndUnavailable).toBe(true);
      expect(restartEvidence.newPostmasterHostPid).not.toBe(
        restartEvidence.previousPostmasterHostPid,
      );
      expect(restartEvidence.newPostmasterStartTime).not.toBe(
        restartEvidence.previousPostmasterStartTime,
      );

      sql = await openNativePostgresSqlClient(fixture.databaseUrl);
      closers.push(() => sql.close());
      service = serviceFor(sql.client);
      await expect(
        service.resolve({
          scope,
          authority,
          commitId: "native-ack-lost",
          expectedVersion: 2,
          digest:
            uncertain.kind === "unknown"
              ? uncertain.digest
              : "sha256:" + "0".repeat(64),
        }),
      ).resolves.toMatchObject({ kind: "committed", receipt: { version: 3 } });
      await expect(service.read({ scope, authority })).resolves.toMatchObject({
        kind: "present",
        version: 3,
        bytes: uncertainBytes,
      });
    } finally {
      try {
        if (database) {
          const { cleanupNativePostgresResources } =
            await import("../helpers/deploy-control/native_postgres_restart.ts");
          const fixture = database;
          await cleanupNativePostgresResources(closers, () => fixture.close());
        }
      } finally {
        await rm(blobRoot, { recursive: true, force: false });
      }
    }
  },
);

async function seedAuthority(
  client: SqlClient,
  scope: PrivateRunFileScope,
  runId: string,
  leaseToken: string,
): Promise<void> {
  const now = new Date().toISOString();
  const projectId = `project_${crypto.randomUUID()}`;
  await client.query(
    `insert into takosumi_workspaces
      (id, handle, space_json, created_at, updated_at, management_state, management_epoch)
     values ($1, $2, '{}'::jsonb, $3, $3, 'active', 1)`,
    [scope.workspaceId, scope.workspaceId, now],
  );
  await client.query(
    `insert into takosumi_projects
      (id, workspace_id, name, slug, project_json, created_at, updated_at)
     values ($1, $2, $3, $4, '{}'::jsonb, $5, $5)`,
    [projectId, scope.workspaceId, projectId, projectId, now],
  );
  await client.query(
    `insert into takosumi_capsules
      (id, space_id, project_id, name, environment, install_config_id, status,
       installation_json, created_at, updated_at, execution_authority_epoch)
     values ($1, $2, $3, $4, $5, $6, 'active', '{}'::jsonb, $7, $7, 1)`,
    [
      scope.capsuleId,
      scope.workspaceId,
      projectId,
      scope.capsuleId,
      scope.environment,
      "native-config",
      now,
    ],
  );
  await client.query(
    `insert into takosumi_runs
      (id, kind, space_id, installation_id, created_at, run_json, status, lease_token)
     values ($1, 'plan', $2, $3, $4,
       $6::jsonb,
       'running', $5)`,
    [
      runId,
      scope.workspaceId,
      scope.capsuleId,
      now,
      leaseToken,
      JSON.stringify({
        id: runId,
        workspaceId: scope.workspaceId,
        capsuleId: scope.capsuleId,
        status: "running",
        capsuleExecutionAuthorityEpoch: 1,
        workspaceManagementAuthority: {
          workspaceId: scope.workspaceId,
          managementState: "active",
          managementEpoch: 1,
        },
      }),
    ],
  );
}

function withOneLostCommitAcknowledgement(client: SqlClient): SqlClient {
  let transactionNumber = 0;
  let dropped = false;
  return {
    query: (sql, parameters) => client.query(sql, parameters),
    async transaction<T>(
      fn: (transaction: SqlTransaction) => T | Promise<T>,
    ): Promise<T> {
      transactionNumber += 1;
      const result = await client.transaction(fn);
      // The service's first transaction checks for an existing receipt; its
      // second transaction finalizes pointer+receipt. Throw only after the
      // real driver reports that transaction committed.
      if (!dropped && transactionNumber === 2) {
        dropped = true;
        throw new Error(
          "simulated lost client acknowledgement after PostgreSQL commit",
        );
      }
      return result;
    },
  };
}
