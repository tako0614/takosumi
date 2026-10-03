import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTakosumiService } from "../../../../core/bootstrap.ts";
import {
  applyExpectedGuardFromPlanRun,
  type OpenTofuApplyJob,
} from "../../../../core/domains/deploy-control/mod.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { StorageMigrationRunner } from "../../../../core/adapters/storage/migration-runner/mod.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import {
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
  fakeProviderVault,
  fixtureExecutionEvidence,
  fixtureStateCommit,
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";
import {
  cleanupNativePostgresResources,
  createNativePostgresRestartContainer,
  openNativePostgresSqlClient,
  type NativePostgresRestartOptions,
  runNativePostgresPhase,
} from "../../../helpers/deploy-control/native_postgres_restart.ts";

const NATIVE_POSTGRES_OPT_IN =
  process.env.TAKOSUMI_TEST_NATIVE_POSTGRES_RESTART === "1";
type CoreService = Awaited<ReturnType<typeof createTakosumiService>>;

type DockerCommand = NonNullable<NativePostgresRestartOptions["runDocker"]>;

function fakeDocker(options: {
  readonly runFailure?: Error;
  readonly createContainerBeforeRunFailure?: boolean;
  readonly foreignRunReadback?: boolean;
  readonly removeFailureAfterRemoval?: Error;
  readonly lowercaseNotFound?: boolean;
  readonly mismatchedNotFoundReference?: boolean;
  readonly oversizedUnusedInspectionFields?: boolean;
} = {}): { readonly run: DockerCommand; readonly commands: string[][]; readonly exists: () => boolean } {
  const commands: string[][] = [];
  let container:
    | {
      readonly id: string;
      readonly name: string;
      readonly inspection: Record<string, unknown>;
    }
    | undefined;
  let publishedEndpoint: string | undefined;
  const run = async (args: readonly string[]) => {
    const command = [...args];
    commands.push(command);
    if (args[0] === "image") return "sha256:cached-test-image";
    if (args[0] === "version") return "29.1.3";
    if (args[0] === "exec" && args[2] === "cat" && args[3] === "/proc/1/comm") {
      return "postgres";
    }
    if (args[0] === "run") {
      const labels: Record<string, string> = {};
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--label") {
          const [name, value] = args[index + 1]!.split("=", 2);
          labels[name!] = value!;
        }
      }
      const name = args[args.indexOf("--name") + 1]!;
      const mount = args[args.indexOf("--mount") + 1]!;
      const source = mount.match(/(?:^|,)source=([^,]+)/u)?.[1] ?? "";
      publishedEndpoint = args[args.indexOf("--publish") + 1]!;
      const hostPort = publishedEndpoint.match(/^127\.0\.0\.1:([1-9][0-9]*):5432$/u)?.[1] ?? "55432";
      const id = "a".repeat(64);
      const inspection: Record<string, unknown> = {
        Id: id,
        Name: `/${name}`,
        Config: {
          Image:
            "postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229",
          ...(options.oversizedUnusedInspectionFields
            ? { Env: [`UNUSED=${"x".repeat(5_000)}`] }
            : {}),
          Labels: {
            ...labels,
            ...(options.foreignRunReadback
              ? { "io.takosumi.test.owner": "foreign-owner" }
              : {}),
          },
        },
        State: {
          Running: true,
          Status: "running",
          Pid: 501,
          Health: {
            Status: "healthy",
            ...(options.oversizedUnusedInspectionFields
              ? { Log: [{ Output: "unrelated health log ".repeat(300) }] }
              : {}),
          },
        },
        NetworkSettings: {
          Ports: {
            "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: hostPort }],
          },
        },
        Mounts: [
          {
            Type: "bind",
            Source: source,
            Destination: "/var/lib/postgresql/data",
            RW: true,
          },
        ],
      };
      if (
        options.runFailure &&
        options.createContainerBeforeRunFailure === false
      ) {
        throw options.runFailure;
      }
      container = { id, name, inspection };
      if (options.runFailure) throw options.runFailure;
      return id;
    }
    if (args[0] === "inspect") {
      const reference = args.at(-1)!;
      if (!container || (reference !== container.id && reference !== container.name)) {
        const missingReference = options.mismatchedNotFoundReference
          ? `${reference}-unrelated`
          : reference;
        throw Object.assign(new Error(`missing ${reference}`), {
          stderr: options.lowercaseNotFound
            ? `error: no such object: ${missingReference}`
            : `Error: No such object: ${missingReference}`,
        });
      }
      const format = args[args.indexOf("--format") + 1];
      const output = format === "{{json .}}"
        ? JSON.stringify(container.inspection)
        : JSON.stringify({
          Id: container.inspection.Id,
          Name: container.inspection.Name,
          Config: {
            Image: (container.inspection.Config as Record<string, unknown>).Image,
            Labels: (container.inspection.Config as Record<string, unknown>).Labels,
          },
          State: (() => {
            const state = container.inspection.State as Record<string, unknown>;
            return {
              Running: state.Running,
              Status: state.Status,
              Pid: state.Pid,
              Health: {
                Status: (state.Health as Record<string, unknown>).Status,
              },
            };
          })(),
          NetworkSettings: {
            Ports: (container.inspection.NetworkSettings as Record<string, unknown>).Ports,
          },
          Mounts: container.inspection.Mounts,
        });
      if (options.oversizedUnusedInspectionFields && Buffer.byteLength(output) > 4096) {
        throw new Error("response exceeded local proof byte cap");
      }
      return output;
    }
    if (args[0] === "stop" && container) {
      const state = container.inspection.State as Record<string, unknown>;
      state.Running = false;
      state.Status = "exited";
      state.Pid = 0;
      return container.id;
    }
    if (args[0] === "start" && container) {
      const state = container.inspection.State as Record<string, unknown>;
      state.Running = true;
      state.Status = "running";
      state.Pid = 502;
      if (publishedEndpoint === "127.0.0.1::5432") {
        const ports = (
          container.inspection.NetworkSettings as {
            Ports: Record<string, { HostIp: string; HostPort: string }[]>;
          }
        ).Ports;
        ports["5432/tcp"]![0]!.HostPort = "55433";
      }
      return container.id;
    }
    if (args[0] === "rm" && container) {
      const removedId = container.id;
      container = undefined;
      if (options.removeFailureAfterRemoval) {
        throw options.removeFailureAfterRemoval;
      }
      return removedId;
    }
    throw new Error(`unexpected fake Docker command: ${args[0]}`);
  };
  return { run, commands, exists: () => container !== undefined };
}

test("container readback projects only required fields under the real 4096-byte transport cap", async () => {
  await withTemporaryDataRoot(async (dataRoot) => {
    const fake = fakeDocker({ oversizedUnusedInspectionFields: true });
    const fixture = await createNativePostgresRestartContainer({
      dataRoot,
      runDocker: fake.run,
      verifyMappedTcp: async () => "2026-10-02T00:00:00.000Z",
    });

    try {
      const inspect = fake.commands.find((args) => args[0] === "inspect");
      expect(inspect).toBeDefined();
      const format = inspect?.[inspect.indexOf("--format") + 1] ?? "";
      expect(format).toContain('{{json .Id}}');
      expect(format).toContain('{{json .Name}}');
      expect(format).toContain('{{json .Config.Image}}');
      expect(format).toContain('index .Config.Labels "io.takosumi.test.owner"');
      expect(format).toContain('index .Config.Labels "io.takosumi.test.purpose"');
      expect(format).toContain('index .Config.Labels "io.takosumi.test.pgdata"');
      expect(format).toContain('{{json .State.Pid}}');
      expect(format).toContain('{{json .State.Health.Status}}');
      expect(format).toContain('index .NetworkSettings.Ports "5432/tcp"');
      expect(format).toContain("{{json .Mounts}}");
      expect(format).not.toContain("{{json .}}");
      expect(format).not.toContain(".Config.Env");
      expect(format).not.toContain(".State.Health.Log");
      expect(fake.exists()).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});

async function withTemporaryDataRoot<T>(
  body: (dataRoot: string) => Promise<T>,
): Promise<T> {
  const dataRoot = await mkdtemp(join(tmpdir(), "takosumi-pg-restart-fault-"));
  try {
    return await body(dataRoot);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test("lost Docker create acknowledgement resolves exact run ownership before cleanup", async () => {
  await withTemporaryDataRoot(async (dataRoot) => {
    const runFailure = Object.assign(new Error("create acknowledgement timed out"), {
      code: "ETIMEDOUT",
    });
    const fake = fakeDocker({
      runFailure,
    });
    await expect(
      createNativePostgresRestartContainer({
        dataRoot,
        runDocker: fake.run,
        verifyMappedTcp: async () => "2026-10-02T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      phase: "container.create",
      message: "native PostgreSQL phase failed",
      cause: runFailure,
    });
    expect(fake.exists()).toBe(false);
    expect(fake.commands.some((args) => args[0] === "rm")).toBe(true);
    const removeIndex = fake.commands.findIndex((args) => args[0] === "rm");
    const preRemoveReadbacks = fake.commands
      .slice(0, removeIndex)
      .filter((args) => args[0] === "inspect")
      .map((args) => args.at(-1));
    expect(
      preRemoveReadbacks.some((reference) =>
        reference?.startsWith("takosumi-pg-restart-")
      ),
    ).toBe(true);
    expect(preRemoveReadbacks).toContain("a".repeat(64));
    expect(await readdir(dataRoot)).toEqual([]);
  });
});

test("fixture readiness health check targets the final PostgreSQL TCP listener", async () => {
  await withTemporaryDataRoot(async (dataRoot) => {
    const fake = fakeDocker();
    const readinessUrls: string[] = [];
    const fixture = await createNativePostgresRestartContainer({
      dataRoot,
      runDocker: fake.run,
      verifyMappedTcp: async (databaseUrl) => {
        readinessUrls.push(databaseUrl);
        if (readinessUrls.length === 1) {
          throw new Error("mapped TCP listener is not ready yet");
        }
        return "2026-10-02T00:00:00.000Z";
      },
    });

    try {
      const create = fake.commands.find((args) => args[0] === "run");
      const healthCommand = create?.[create.indexOf("--health-cmd") + 1];
      expect(healthCommand).toBe(
        "pg_isready -h 127.0.0.1 -U native_restart -d native_restart",
      );
      const publishedHostPort = create?.[create.indexOf("--publish") + 1]
        ?.match(/^127\.0\.0\.1:([1-9][0-9]*):5432$/u)?.[1];
      expect(
        publishedHostPort !== undefined &&
          fixture.databaseUrl.includes(`@127.0.0.1:${publishedHostPort}/`),
      ).toBe(true);
      expect(readinessUrls.length).toBe(2);
      expect(readinessUrls[1] === fixture.databaseUrl).toBe(true);
      expect(fake.commands).toContainEqual([
        "exec",
        fixture.containerId,
        "cat",
        "/proc/1/comm",
      ]);
    } finally {
      await fixture.close();
    }
  });
});

test("fixture pins one positive loopback host port across daemon restart", async () => {
  await withTemporaryDataRoot(async (dataRoot) => {
    const fake = fakeDocker();
    let tcpProbeCount = 0;
    const fixture = await createNativePostgresRestartContainer({
      dataRoot,
      runDocker: fake.run,
      verifyMappedTcp: async () => {
        tcpProbeCount += 1;
        return tcpProbeCount < 3
          ? "2026-10-02T00:00:00.000Z"
          : "2026-10-02T00:01:00.000Z";
      },
      verifyDatabaseUnavailable: async () => {},
    });

    try {
      const create = fake.commands.find((args) => args[0] === "run");
      const publishedEndpoint = create?.[create.indexOf("--publish") + 1];
      const hostPort = publishedEndpoint?.match(
        /^127\.0\.0\.1:([1-9][0-9]*):5432$/u,
      )?.[1];
      expect(hostPort).toBeString();
      expect(
        fixture.databaseUrl.includes(`@127.0.0.1:${hostPort}/`),
      ).toBe(true);
      const restart = await fixture.restartPostgresDaemon();
      expect(restart.stoppedAndUnavailable).toBe(true);
      expect(restart.previousPostmasterHostPid).toBe(501);
      expect(restart.newPostmasterHostPid).toBe(502);
      expect(restart.previousPostmasterStartTime).toBe("2026-10-02T00:00:00.000Z");
      expect(restart.newPostmasterStartTime).toBe("2026-10-02T00:01:00.000Z");
      expect(fake.commands.filter((args) => args[0] === "start")).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });
});

test("loopback bind failure does not retry create or discard unresolved PGDATA custody", async () => {
  await withTemporaryDataRoot(async (dataRoot) => {
    const fake = fakeDocker({
      runFailure: Object.assign(new Error("reserved loopback host-port bind failed"), {
        code: "EADDRINUSE",
      }),
      createContainerBeforeRunFailure: false,
    });
    const error = await createNativePostgresRestartContainer({
      dataRoot,
      runDocker: fake.run,
      verifyMappedTcp: async () => "2026-10-02T00:00:00.000Z",
    }).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toMatch(
      /custody is retained; operator recovery path/u,
    );
    expect((error as AggregateError).errors[1]).toMatchObject({
      phase: "container.setup.resolve-cleanup",
      message: "native PostgreSQL phase failed",
      cause: { message: expect.stringContaining("no-effect is not proven") },
    });
    expect(fake.commands.filter((args) => args[0] === "run")).toHaveLength(1);
    expect(fake.exists()).toBe(false);
    expect(fake.commands.some((args) => args[0] === "stop")).toBe(false);
    expect(fake.commands.some((args) => args[0] === "rm")).toBe(false);
    const [runRootName] = await readdir(dataRoot);
    expect(runRootName).toBeString();
    expect((await readdir(join(dataRoot, runRootName!))).sort()).toEqual([
      "pgdata",
      "postgres.env",
    ]);
  });
});

test("foreign create readback retains the private run root without touching that container", async () => {
  await withTemporaryDataRoot(async (dataRoot) => {
    const fake = fakeDocker({
      runFailure: Object.assign(new Error("create acknowledgement timed out"), {
        code: "ETIMEDOUT",
      }),
      foreignRunReadback: true,
    });
    await expect(
      createNativePostgresRestartContainer({
        dataRoot,
        runDocker: fake.run,
        verifyMappedTcp: async () => "2026-10-02T00:00:00.000Z",
      }),
    ).rejects.toThrow(/retained.*recovery path/u);
    expect(fake.exists()).toBe(true);
    expect(fake.commands.some((args) => args[0] === "stop")).toBe(false);
    expect(fake.commands.some((args) => args[0] === "rm")).toBe(false);
    const [runRootName] = await readdir(dataRoot);
    expect(runRootName).toBeString();
    const runRoot = join(dataRoot, runRootName!);
    expect((await readdir(runRoot)).sort()).toEqual(["pgdata", "postgres.env"]);
    expect(await readdir(join(runRoot, "pgdata"))).toEqual([]);
    expect((await stat(runRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(join(runRoot, "postgres.env"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(runRoot, "pgdata"))).mode & 0o777).toBe(0o700);
  });
});

test("lost Docker remove acknowledgement is resolved by exact-ID absence before filesystem cleanup", async () => {
  await withTemporaryDataRoot(async (dataRoot) => {
    const fake = fakeDocker({
      removeFailureAfterRemoval: Object.assign(
        new Error("remove acknowledgement timed out"),
        { code: "ETIMEDOUT" },
      ),
    });
    const fixture = await createNativePostgresRestartContainer({
      dataRoot,
      runDocker: fake.run,
      verifyMappedTcp: async () => "2026-10-02T00:00:00.000Z",
    });
    await fixture.close();
    expect(fake.exists()).toBe(false);
    const removeIndex = fake.commands.findIndex((args) => args[0] === "rm");
    const afterRemoveReadbacks = fake.commands
      .slice(removeIndex + 1)
      .filter((args) => args[0] === "inspect")
      .map((args) => args.at(-1));
    expect(afterRemoveReadbacks[0]).toBe(fixture.containerId);
    expect(afterRemoveReadbacks[1]).toMatch(/^takosumi-pg-restart-/u);
    expect(await readdir(dataRoot)).toEqual([]);
  });
});

test("lost Docker remove acknowledgement accepts exact lowercase not-found readbacks", async () => {
  await withTemporaryDataRoot(async (dataRoot) => {
    const fake = fakeDocker({
      lowercaseNotFound: true,
      removeFailureAfterRemoval: Object.assign(
        new Error("remove acknowledgement timed out"),
        { code: "ETIMEDOUT" },
      ),
    });
    const fixture = await createNativePostgresRestartContainer({
      dataRoot,
      runDocker: fake.run,
      verifyMappedTcp: async () => "2026-10-02T00:00:00.000Z",
    });

    await fixture.close();

    expect(fake.exists()).toBe(false);
    expect(await readdir(dataRoot)).toEqual([]);
  });
});

test("lowercase not-found for a different reference does not prove absence", async () => {
  await withTemporaryDataRoot(async (dataRoot) => {
    const fake = fakeDocker({
      runFailure: Object.assign(new Error("create acknowledgement timed out"), {
        code: "ETIMEDOUT",
      }),
      createContainerBeforeRunFailure: false,
      lowercaseNotFound: true,
      mismatchedNotFoundReference: true,
    });
    const error = await createNativePostgresRestartContainer({
      dataRoot,
      runDocker: fake.run,
      verifyMappedTcp: async () => "2026-10-02T00:00:00.000Z",
    }).then(() => undefined, (failure: unknown) => failure);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toMatch(
      /custody is retained; operator recovery path/u,
    );
    expect(fake.exists()).toBe(false);
    expect(fake.commands.some((args) => args[0] === "rm")).toBe(false);
    const [runRootName] = await readdir(dataRoot);
    expect(runRootName).toBeString();
    expect((await readdir(join(dataRoot, runRootName!))).sort()).toEqual([
      "pgdata",
      "postgres.env",
    ]);
  });
});

test("pool close failure still attempts exact container cleanup and preserves the error", async () => {
  const events: string[] = [];
  const poolFailure = new Error("pool close failed");
  const result = await cleanupNativePostgresResources(
    [
      async () => {
        events.push("pool-failed");
        throw poolFailure;
      },
      async () => {
        events.push("pool-closed");
      },
    ],
    async () => {
      events.push("container-cleanup");
    },
  ).then(() => undefined, (error: unknown) => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect((result as AggregateError).errors).toContainEqual(
    expect.objectContaining({
      phase: "cleanup.pool-close",
      message: "native PostgreSQL phase failed",
      cause: poolFailure,
    }),
  );
  expect(events).toEqual([
    "pool-failed",
    "pool-closed",
    "container-cleanup",
  ]);
});

function createDeterministicRunner() {
  let applyCalls = 0;
  return {
    runner: {
      plan: () =>
        Promise.resolve({
          planDigest:
            "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          planArtifact: {
            kind: "runner-local" as const,
            ref: "runner-local://native-pg-restart/tfplan",
            digest:
              "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          },
          providerLockDigest:
            "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
          providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
        }),
      apply: (job: OpenTofuApplyJob) => {
        applyCalls += 1;
        return Promise.resolve(
          fixtureStateCommit({
            rawOutputRef: job.rawOutputRef,
            outputs: {
              launch_url: {
                sensitive: false,
                value: "https://native-pg-restart.example.test",
              },
            },
            providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
            executionEvidence: fixtureExecutionEvidence(job, "apply"),
          }),
        );
      },
    },
    applyCallCount: () => applyCalls,
  };
}

test.skipIf(!NATIVE_POSTGRES_OPT_IN)(
  "Core Apply lineage and exact replay survive a real PostgreSQL daemon restart",
  async () => {
    const database = await runNativePostgresPhase(
      "fixture.create",
      () => createNativePostgresRestartContainer(),
    );
    let firstClient: Awaited<ReturnType<typeof openNativePostgresSqlClient>> | undefined;
    let restartedClient:
      | Awaited<ReturnType<typeof openNativePostgresSqlClient>>
      | undefined;

    let testFailed = false;
    let testError: unknown;
    try {
      firstClient = await runNativePostgresPhase(
        "pool.first.open",
        () => openNativePostgresSqlClient(database.databaseUrl),
      );
      const migrations = new StorageMigrationRunner(firstClient.client);
      const migrationResult = await runNativePostgresPhase(
        "migration.apply-pending",
        () => migrations.applyPending(),
      );
      expect(migrationResult.appliedNow.length).toBeGreaterThan(0);
      const migrationStatus = await runNativePostgresPhase(
        "migration.verify-current",
        () => migrations.verifyCurrent(),
      );
      expect(migrationStatus.pending).toEqual([]);

      const store = new SqlOpenTofuControlStore({ client: firstClient.client });
      // Synthetic owner/connection fixtures and a deterministic fake runner
      // exercise Core persistence only, not Accounts authentication or actual
      // OpenTofu/provider execution.
      const seeded = await runNativePostgresPhase(
        "seed.fixture",
        async () => {
          const result = await seedCapsuleModel(store, {
            workspaceId: "workspace_native_pg_restart",
            capsuleId: "cap_native_pg_restart",
            sourceId: "src_native_pg_restart",
            snapshotId: "snap_native_pg_restart",
            installConfigId: "cfg_native_pg_restart",
            requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
          });
          await seedProviderConnections(store, result.capsule);
          await store.putCapsuleCompatibilityReport({
            id: "caprep_native_pg_restart",
            sourceId: result.source.id,
            capsuleId: result.capsule.id,
            sourceSnapshotId: result.snapshot.id,
            modulePath: ".",
            level: "ready",
            findings: [],
            providerPackages: [
              { source: FIXTURE_CLOUDFLARE_PROVIDER, allowed: true },
            ],
            rootProviderRequirements: [
              {
                source: FIXTURE_CLOUDFLARE_PROVIDER,
                moduleLocalName: "cloudflare",
              },
            ],
            resources: [],
            dataSources: [],
            provisioners: [],
            rootModuleOutputs: [
              { name: "launch_url", sensitive: false, ephemeral: false },
            ],
            createdAt: "2026-06-06T00:00:00.000Z",
          });
          await store.putCapsule({
            ...result.capsule,
            compatibilityReportId: "caprep_native_pg_restart",
            compatibilityStatus: "ready",
          });
          return result;
        },
      );

      const runner = createDeterministicRunner();
      const firstService = await runNativePostgresPhase(
        "core.bootstrap.first",
        () => createTakosumiService({
          role: "takosumi-api",
          runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
          sqlClient: firstClient!.client,
          opentofuRunner: runner.runner,
          opentofuConnectionVault: fakeProviderVault() as never,
          executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
          artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
        }),
      );
      const { planRun } = await runNativePostgresPhase(
        "core.plan",
        () => firstService.operations.controller.createCapsulePlan(
          seeded.capsule.id,
        ),
      );
      expect(planRun.status).toBe("succeeded");
      const { applyRun } = await runNativePostgresPhase(
        "core.apply",
        () => firstService.operations.controller.createApplyRun({
          planRunId: planRun.id,
          expected: applyExpectedGuardFromPlanRun(planRun),
        }),
      );
      expect(applyRun.status).toBe("succeeded");
      expect(applyRun.stateVersionId).toBeString();
      expect(applyRun.outputId).toBeString();
      expect(runner.applyCallCount()).toBe(1);

      const identities = {
        sourceId: seeded.source.id,
        sourceSnapshotId: seeded.snapshot.id,
        capsuleId: seeded.capsule.id,
        planRunId: planRun.id,
        applyRunId: applyRun.id,
        stateVersionId: applyRun.stateVersionId!,
        outputId: applyRun.outputId!,
      };
      const readLineage = async (
        service: CoreService,
      ) => {
        const [source, sourceSnapshot, capsule, plan, applied, run, state, output] =
          await Promise.all([
            service.operations.getSource(identities.sourceId),
            service.operations.getSourceSnapshot(identities.sourceSnapshotId),
            service.operations.controller.getCapsule(identities.capsuleId),
            service.operations.controller.getPlanRun(identities.planRunId),
            service.operations.controller.getApplyRun(identities.applyRunId),
            service.operations.controller.getRun(identities.applyRunId),
            service.operations.controller.getStateVersion(
              identities.stateVersionId,
            ),
            service.operations.controller.getOutput(identities.outputId),
          ]);
        return {
          source: source.source,
          sourceSnapshot,
          capsule: capsule.capsule,
          planRun: plan.planRun,
          applyRun: applied.applyRun,
          run,
          stateVersion: state.stateVersion,
          output,
        };
      };

      const beforeRestart = await runNativePostgresPhase(
        "core.lineage.before-restart",
        () => readLineage(firstService),
      );
      expect(beforeRestart.source.id).toBe(identities.sourceId);
      expect(beforeRestart.sourceSnapshot.id).toBe(identities.sourceSnapshotId);
      expect(beforeRestart.planRun.sourceSnapshotId).toBe(
        identities.sourceSnapshotId,
      );
      expect(beforeRestart.applyRun.id).toBe(identities.applyRunId);
      expect(beforeRestart.run.id).toBe(identities.applyRunId);
      expect(beforeRestart.capsule.currentStateVersionId).toBe(
        identities.stateVersionId,
      );
      expect(beforeRestart.capsule.currentStateGeneration).toBe(1);
      expect(beforeRestart.stateVersion.id).toBe(identities.stateVersionId);
      expect(beforeRestart.stateVersion.generation).toBe(1);
      expect(beforeRestart.stateVersion.createdByRunId).toBe(
        identities.applyRunId,
      );
      expect(beforeRestart.applyRun.outputId).toBe(identities.outputId);
      expect(beforeRestart.output).toMatchObject({
        id: identities.outputId,
        publicOutputs: {
          launch_url: "https://native-pg-restart.example.test",
        },
      });
      expect(
        await firstService.operations.controller.listStateVersionsByWorkspace(
          "workspace_native_pg_restart",
        ),
      ).toHaveLength(1);

      const oldClient = firstClient!;
      await runNativePostgresPhase(
        "pool.first.close",
        () => oldClient.close(),
      );
      firstClient = undefined;
      const restart = await runNativePostgresPhase(
        "daemon.restart-lifecycle",
        () => database.restartPostgresDaemon(),
      );
      expect(restart).toMatchObject({ stoppedAndUnavailable: true });
      expect(restart.previousPostmasterHostPid).toBeGreaterThan(0);
      expect(restart.newPostmasterHostPid).toBeGreaterThan(0);
      expect(restart.newPostmasterHostPid).not.toBe(
        restart.previousPostmasterHostPid,
      );
      expect(restart.previousPostmasterStartTime).not.toBe(
        restart.newPostmasterStartTime,
      );

      restartedClient = await runNativePostgresPhase(
        "pool.restarted.open",
        () => openNativePostgresSqlClient(database.databaseUrl),
      );
      const freshService = await runNativePostgresPhase(
        "core.bootstrap.restarted",
        () => createTakosumiService({
          role: "takosumi-api",
          runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
          sqlClient: restartedClient!.client,
          opentofuRunner: runner.runner,
          opentofuConnectionVault: fakeProviderVault() as never,
          executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
          artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
        }),
      );
      const afterRestart = await runNativePostgresPhase(
        "core.lineage.after-restart",
        () => readLineage(freshService),
      );
      expect(afterRestart).toEqual(beforeRestart);

      await runNativePostgresPhase("core.replay", async () => {
        const runCountBeforeReplay =
          await freshService.operations.controller.listRuns(
            "workspace_native_pg_restart",
          );
        const replay = await freshService.operations.controller.createApplyRun({
          planRunId: identities.planRunId,
          expected: applyExpectedGuardFromPlanRun(beforeRestart.planRun),
        });
        expect(replay.applyRun.id).toBe(identities.applyRunId);
        expect(replay.applyRun.stateVersionId).toBe(identities.stateVersionId);
        expect(replay.applyRun.outputId).toBe(identities.outputId);
        expect(
          await freshService.operations.controller.listRuns(
            "workspace_native_pg_restart",
          ),
        ).toHaveLength(runCountBeforeReplay.length);
        expect(
          await freshService.operations.controller.listStateVersionsByWorkspace(
            "workspace_native_pg_restart",
          ),
        ).toHaveLength(1);
        expect(runner.applyCallCount()).toBe(1);
        expect(await readLineage(freshService)).toEqual(beforeRestart);
      });
    } catch (error) {
      testFailed = true;
      testError = error;
    }

    const poolClosers: Array<() => Promise<void>> = [];
    if (restartedClient) {
      const client = restartedClient;
      poolClosers.push(() => client.close());
    }
    if (firstClient) {
      const client = firstClient;
      poolClosers.push(() => client.close());
    }
    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
      await runNativePostgresPhase("cleanup.all", () =>
        cleanupNativePostgresResources(poolClosers, () => database.close())
      );
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;
    }

    if (testFailed && cleanupFailed) {
      throw new AggregateError(
        [testError, cleanupError],
        "native PostgreSQL lifecycle failed and resource cleanup also failed",
      );
    }
    if (testFailed) throw testError;
    if (cleanupFailed) throw cleanupError;
  },
);
