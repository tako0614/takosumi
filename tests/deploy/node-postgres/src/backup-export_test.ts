import { expect, test } from "bun:test";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PostgresAccountsStore,
  type PostgresQueryClient,
} from "@takosjp/takosumi-accounts-service";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { StateArtifactCrypto } from "../../../../worker/src/state_crypto.ts";
import { FileBackupArtifactStore } from "../../../../deploy/node-postgres/src/file-backup-artifact-store.ts";
import { buildComposedApp } from "../../../../deploy/node-postgres/src/composed-app.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const SECRET_MARKER = "fixture-state-secret-should-never-be-plaintext";
const STATE_PLAINTEXT = new TextEncoder().encode(
  JSON.stringify({
    version: 4,
    serial: 1,
    lineage: "backup-export-fixture-lineage",
    outputs: { private_marker: { value: SECRET_MARKER, type: "string" } },
    resources: [],
  }),
);
const PASSPHRASE = "backup-export-integration-passphrase-is-long-enough-32-bytes";
const REQUESTER_SUBJECT = "tsub_backup_export_owner";

function tarEntry(tar: Uint8Array, name: string): Uint8Array {
  for (let offset = 0; offset + 512 <= tar.byteLength;) {
    const header = tar.slice(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const entryName = new TextDecoder().decode(header.slice(0, 100)).replace(/\0.*$/u, "");
    const sizeText = new TextDecoder().decode(header.slice(124, 136)).replace(/\0.*$/u, "").trim();
    const size = Number.parseInt(sizeText, 8);
    const bodyStart = offset + 512;
    if (entryName === name) return tar.slice(bodyStart, bodyStart + size);
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`missing tar entry ${name}`);
}

function accountsQueryClient(): PostgresQueryClient {
  return {
    queryObject: () => {
      throw new Error("unexpected Accounts query in backup export integration");
    },
  };
}

function testConfig() {
  return {
    bindHost: "127.0.0.1",
    port: 8787,
    issuer: "http://localhost:8787",
    databaseUrl: "postgres://unused",
    clients: undefined,
    loginEmailAllowlist: undefined,
    passkeys: undefined,
    upstreamOAuth: undefined,
    stableOidc: undefined,
    privacyOperationsToken: undefined,
    privacyRetentionPolicyRef: undefined,
    subject: undefined,
  };
}

test("self-host composed backup exports during uninstall grace and the due finalizer exports before teardown", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-backup-export-"));
  const backupRoot = join(root, "backup-artifacts");
  const client = await PGliteSqlClient.create();
  try {
    const runtimeEnv = {
      TAKOSUMI_ENVIRONMENT: "test",
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_SECRET_STORE_PASSPHRASE: PASSPHRASE,
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "backup-export-test-token",
      TAKOSUMI_BACKUP_ARTIFACTS_DIR: backupRoot,
      TAKOSUMI_UNINSTALL_GRACE_DAYS: "7",
    };
    const store = new SqlOpenTofuControlStore({ client });
    const crypto = StateArtifactCrypto.fromEnv(runtimeEnv);
    const sealedState = await crypto.seal(STATE_PLAINTEXT);
    const accountsStore = new PostgresAccountsStore(accountsQueryClient());
    accountsStore.findAccount = async (subject) =>
      subject === REQUESTER_SUBJECT
        ? { subject, createdAt: Date.now(), updatedAt: Date.now() }
        : undefined;
    const created = await buildComposedApp({
      config: testConfig(),
      store: accountsStore,
      // This scenario exercises the embedded control operations, while the
      // composer requires an Accounts handler to finish mounting its routes.
      accountsHandler: async () => new Response("unused"),
      sqlClient: client,
      opentofuControlStore: store,
      runtimeEnv,
      backupStateObjectReader: {
        get: async (ref) => ref === "opaque-sealed-state-ref"
          ? sealedState.ciphertext
          : undefined,
      },
    });

    const seeded = await seedCapsuleModel(store, {
      workspaceId: "workspace_backup_export_regression",
      capsuleId: "capsule_backup_export_regression",
      sourceId: "source_backup_export_regression",
      snapshotId: "snapshot_backup_export_regression",
      installConfigId: "config_backup_export_regression",
      environment: "test",
      name: "backup-export-regression",
    });
    await store.putWorkspace({
      ...seeded.workspace,
      ownerUserId: REQUESTER_SUBJECT,
    });
    const stateVersion = {
      id: "state_backup_export_regression",
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      environment: seeded.capsule.environment,
      generation: 1,
      stateRef: "opaque-sealed-state-ref",
      digest: sealedState.contentDigest,
      createdByRunId: "apply_backup_export_regression",
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    await store.putStateVersion(stateVersion);
    await store.patchCapsule(seeded.capsule.id, {
      status: "active",
      currentStateVersionId: stateVersion.id,
      currentStateGeneration: stateVersion.generation,
      updatedAt: stateVersion.createdAt,
    }, {
      currentStateVersionId: undefined,
      status: "pending",
    });

    const scheduled = await created.operations.capsules.scheduleCapsuleUninstall(
      seeded.capsule.id,
      {
        actor: REQUESTER_SUBJECT,
        requester: { subject: REQUESTER_SUBJECT },
      },
    );
    expect(scheduled.status).toBe("uninstalled");
    expect(scheduled.uninstall?.phase).toBe("scheduled");
    if (!scheduled.uninstall) throw new Error("uninstall grace record missing");
    const expectedDeadline = Date.parse(scheduled.uninstall.requestedAt) + 7 * 24 * 60 * 60 * 1000;
    expect(Date.parse(scheduled.uninstall.scheduledDestroyAt)).toBe(expectedDeadline);
    const beforeGraceBackup = await created.operations.capsules.getCapsule(seeded.capsule.id);

    const manualBackup = await created.operations.backups.createBackup({
      workspaceId: seeded.workspace.id,
      capsuleId: seeded.capsule.id,
      environment: seeded.capsule.environment,
      scope: "capsule",
    });
    expect(manualBackup.stateArchive).toBeDefined();
    expect(manualBackup.artifactsManifest).toBeDefined();
    const afterGraceBackup = await created.operations.capsules.getCapsule(seeded.capsule.id);
    expect(afterGraceBackup.status).toBe(beforeGraceBackup.status);
    expect(afterGraceBackup.uninstall).toEqual(beforeGraceBackup.uninstall);

    const artifactStore = await FileBackupArtifactStore.create({
      root: backupRoot,
      crypto,
    });
    const manifestBytes = await artifactStore.get(manualBackup.artifactsManifest!.ref);
    expect(manifestBytes).toBeDefined();
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
      readonly kind: string;
      readonly artifacts: readonly { readonly kind: string; readonly ref: string }[];
    };
    expect(manifest.kind).toBe("backup-artifacts-manifest");
    expect(manifest.artifacts.map(({ kind }) => kind).sort()).toEqual(["control", "state"]);
    expect(manifest.artifacts.some(({ ref }) => ref === manualBackup.stateArchive!.ref)).toBe(true);
    const sealedControl = await artifactStore.get(manualBackup.ref);
    const sealedStateArchive = await artifactStore.get(manualBackup.stateArchive!.ref);
    expect(sealedControl?.subarray(0, 5)).toEqual(new Uint8Array([0x54, 0x4b, 0x53, 0x41, 0x02]));
    expect(sealedStateArchive?.subarray(0, 5)).toEqual(new Uint8Array([0x54, 0x4b, 0x53, 0x41, 0x02]));
    expect(await crypto.open(sealedState.ciphertext)).toEqual(STATE_PLAINTEXT);
    const controlPlaintext = await crypto.open(sealedControl!);
    const statePlaintext = await crypto.open(sealedStateArchive!);
    const controlBundle = JSON.parse(new TextDecoder().decode(Bun.zstdDecompressSync(controlPlaintext))) as {
      readonly workspaceId: string;
      readonly capsules: readonly { readonly id: string }[];
    };
    expect(controlBundle.workspaceId).toBe(seeded.workspace.id);
    expect(controlBundle.capsules.some(({ id }) => id === seeded.capsule.id)).toBe(true);
    const stateTar = Bun.zstdDecompressSync(statePlaintext);
    const stateMetadata = JSON.parse(new TextDecoder().decode(tarEntry(stateTar, "state.json"))) as {
      readonly kind: string;
      readonly stateVersions: readonly { readonly id: string }[];
    };
    expect(stateMetadata.kind).toBe("state-backup-archive");
    expect(stateMetadata.stateVersions.map(({ id }) => id)).toEqual([stateVersion.id]);
    expect(tarEntry(
      stateTar,
      `states/${seeded.capsule.id}/${seeded.capsule.environment}/00000001.tfstate.enc`,
    )).toEqual(sealedState.ciphertext);

    // Keep the seven-day schedule assertion above, then advance the durable
    // fixture deadline to the past to model the grace period elapsing without
    // sleeping for a week. Exercise the exact self-host composition operation.
    await store.putCapsule({
      ...scheduled,
      uninstall: {
        ...scheduled.uninstall,
        scheduledDestroyAt: new Date(Date.now() - 1).toISOString(),
      },
    });
    const finalization = await created.operations.finalizeDueCapsuleUninstalls({ limit: 1 });
    expect(finalization.exportsRecorded).toBe(1);
    const afterAutomaticExport = await created.operations.capsules.getCapsule(seeded.capsule.id);
    expect(afterAutomaticExport.status).toBe("uninstalled");
    expect(afterAutomaticExport.uninstall?.preDestroyExport?.status).toBe("exported");
    expect(afterAutomaticExport.uninstall?.preDestroyExport?.backupId).toBeDefined();
    const backups = await created.operations.backups.listBackups(seeded.workspace.id);
    expect(backups.backups).toHaveLength(2);

    const files = await readdir(backupRoot);
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect((await stat(backupRoot)).mode & 0o7777).toBe(0o700);
    for (const file of files) {
      const path = join(backupRoot, file);
      expect((await stat(path)).mode & 0o7777).toBe(0o600);
      expect(new TextDecoder().decode(await readFile(path))).not.toContain(SECRET_MARKER);
    }
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
