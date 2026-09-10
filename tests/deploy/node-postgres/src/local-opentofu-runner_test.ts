// takos-secret-scan: synthetic — the runner fixture sets a named placeholder Cloudflare token.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileOpenTofuStateArtifactStore,
  createHttpOpenTofuRunner,
  createLocalOpenTofuRunner,
  createLocalOpenTofuRunnerProfile,
  type LocalOpenTofuProviderLockfileArtifact,
  type SourceArchiveStore,
} from "../../../../deploy/node-postgres/src/local-opentofu-runner.ts";
import { generateOpenTofuChildModuleRoot } from "../../../../lib/rootgen/src/mod.ts";
import { workspaceForRun } from "../../../../runner/lib/artifacts.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { OpenTofuRunnerInfrastructureError } from "../../../../core/domains/deploy-control/errors.ts";

const TEST_STATE_CRYPTO = new PartitionedSecretBoundaryCrypto({
  globalPassphrase: "local-opentofu-state-test-passphrase-32-bytes-minimum",
});

test("local OpenTofu runner executes generic release commands in restored source", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-local-runner-"));
  try {
    const sourceDir = join(tempDir, "source");
    const archivePath = join(tempDir, "source.tar.zst");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "marker.txt"), "plain source\n");
    createArchive(sourceDir, archivePath);
    const archiveBytes = new Uint8Array(await readFile(archivePath));
    const archiveDigest = `sha256:${createHash("sha256")
      .update(archiveBytes)
      .digest("hex")}`;
    const archiveStore: SourceArchiveStore = {
      write: async () => {
        throw new Error("write should not be called");
      },
      read: async () => archiveBytes,
    };
    const runner = createLocalOpenTofuRunner({
      archiveStore,
      stateStore: createFileOpenTofuStateArtifactStore(
        join(tempDir, "state-artifacts"),
        TEST_STATE_CRYPTO,
      ),
    });

    const result = await runner.release!({
      runId: "release_apply_1",
      applyRunId: "apply_1",
      capsuleId: "inst_1",
      stateVersionId: "state_1",
      sourceSnapshot: {
        id: "snap_1",
        resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
        archiveRef: "sources/snap_1/source.tar.zst",
        archiveDigest,
      } as never,
      nonSensitiveOutputs: {
        public_url: "https://app.example.test",
      },
      providerConfigurations: {
        format: "takosumi.provider-configurations@v1",
        providers: [
          {
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            alias: null,
            configuration: {
              base_url: "https://provider.example.test/api",
            },
          },
        ],
      },
      credentials: {
        env: {
          CLOUDFLARE_API_TOKEN: "fixture-cloudflare-release-token",
        },
        manifest: {
          bindings: [
            {
              providerSource: "registry.opentofu.org/cloudflare/cloudflare",
              connectionId: "conn_release_fixture",
              recipeId: "cloudflare",
              authMode: "api_token",
              envNames: ["CLOUDFLARE_API_TOKEN"],
              fileEnvNames: [],
              requiredEnvGroups: [["CLOUDFLARE_API_TOKEN"]],
            },
          ],
        },
      },
      commands: [
        {
          id: "activate",
          phase: "post_apply",
          executor: "runner",
          command: [
            process.execPath,
            "-e",
            [
              "const outputs = JSON.parse(Bun.env.TAKOSUMI_OUTPUTS_JSON)",
              "const providerConfigs = JSON.parse(Bun.env.TAKOSUMI_PROVIDER_CONFIGS_JSON)",
              "if (Bun.env.CLOUDFLARE_API_TOKEN !== 'fixture-cloudflare-release-token') process.exit(7)",
              "if (Bun.env.TAKOSUMI_SOURCE_SNAPSHOT_ID !== 'snap_1') process.exit(8)",
              "if (Bun.env.TAKOSUMI_SOURCE_COMMIT !== '0123456789abcdef0123456789abcdef01234567') process.exit(9)",
              "console.log(`${Bun.env.TAKOSUMI_APPLY_RUN_ID}:${outputs.public_url}:${providerConfigs.providers[0].configuration.base_url}`)",
              "console.log(`token=${Bun.env.CLOUDFLARE_API_TOKEN}`)",
              "console.log(`source=${Bun.env.TAKOSUMI_SOURCE_SNAPSHOT_ID}:${Bun.env.TAKOSUMI_SOURCE_COMMIT}`)",
            ].join(";"),
          ],
          workingDirectory: ".",
        },
      ],
    });

    expect(result.status).toBe("succeeded");
    expect(result.runId).toBe("release_apply_1");
    expect(result.commandCount).toBe(1);
    expect(result.stdout).toContain(
      "apply_1:https://app.example.test:https://provider.example.test/api",
    );
    expect(result.stdout).toContain("token=[redacted]");
    expect(result.stdout).toContain("source=[redacted]:[redacted]");
    expect(result.stdout).not.toContain("snap_1");
    expect(result.stdout).not.toContain(
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(JSON.stringify(result)).not.toContain(
      "fixture-cloudflare-release-token",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("local OpenTofu runner durably commits and replays exact apply and destroy state", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-local-state-"));
  const runIds = ["plan_create", "apply_create", "plan_destroy", "apply_destroy"].map(
    (prefix) => `${prefix}_${crypto.randomUUID()}`,
  );
  const [createPlanId, createApplyId, destroyPlanId, destroyApplyId] = runIds as [
    string,
    string,
    string,
    string,
  ];
  try {
    const sourceDir = join(tempDir, "source");
    const archivePath = join(tempDir, "source.tar.zst");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "main.tf"),
      'output "message" {\n  value = "durable-local-state"\n}\n',
    );
    createArchive(sourceDir, archivePath);
    const archiveBytes = new Uint8Array(await readFile(archivePath));
    const sourceArchive = {
      ref: "sources/snap_local/source.tar.zst",
      digest: `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}`,
    };
    const stateArtifactDir = join(tempDir, "state-artifacts");
    const durableStateStore = createFileOpenTofuStateArtifactStore(
      stateArtifactDir,
      TEST_STATE_CRYPTO,
    );
    let rawOutputCommitAttempts = 0;
    const stateStore = {
      read: durableStateStore.read,
      commit: durableStateStore.commit,
      readRawOutput: durableStateStore.readRawOutput,
      async commitRawOutput(
        artifact: Parameters<typeof durableStateStore.commitRawOutput>[0],
      ) {
        rawOutputCommitAttempts += 1;
        if (rawOutputCommitAttempts === 1) {
          throw new Error("simulated raw output durable commit outage");
        }
        return await durableStateStore.commitRawOutput(artifact);
      },
    };
    const runner = createLocalOpenTofuRunner({
      archiveStore: {
        write: async () => {
          throw new Error("write should not be called");
        },
        read: async () => archiveBytes,
      },
      stateStore,
    });
    const profile = createLocalOpenTofuRunnerProfile();
    const generatedRoot = generateOpenTofuChildModuleRoot({
      rootProviderRequirements: [],
      inputs: {},
      outputAllowlist: {
        message: { from: "message", type: "string" },
      },
    });
    const createPlanRun = localPlanRun(createPlanId, "create");
    const createPlan = await runner.plan({
      planRun: createPlanRun,
      runnerProfile: profile,
      variables: {},
      generatedRoot,
      sourceArchive,
      outputAllowlist: { message: { from: "message" } },
      stateScope: stateScope(0, "artifact:local-state:0"),
    });
    const generationOneRef = "artifact:local-state:1";
    const rawOutputRef = `artifact:local-output:${createApplyId}`;
    const createApplyRun = localApplyRun(createApplyId, createPlanId, "create");
    const createApplyPlanRun = {
      ...createPlanRun,
      planDigest: createPlan.planDigest,
      planArtifact: createPlan.planArtifact,
    };
    const applyJob = {
      applyRun: createApplyRun,
      planRun: createApplyPlanRun,
      planArtifact: createPlan.planArtifact,
      runnerProfile: profile,
      executionEvidenceAuthority: testExecutionEvidenceAuthority(),
      generatedRoot,
      sourceArchive,
      outputAllowlist: { message: { from: "message" } },
      stateScope: stateScope(1, generationOneRef),
      rawOutputRef,
      executionEvidenceCommit: {
        stateVersionId: generationOneRef,
        outputId: `output:${createApplyId}`,
      },
    };
    let firstApplyError: unknown;
    try {
      await runner.apply(applyJob);
    } catch (error) {
      firstApplyError = error;
    }
    expect(firstApplyError).toBeInstanceOf(
      OpenTofuRunnerInfrastructureError,
    );
    expect(
      (firstApplyError as OpenTofuRunnerInfrastructureError).reason,
    ).toBe("runner_artifact_relay_ambiguous");
    const originalError = (
      firstApplyError as OpenTofuRunnerInfrastructureError
    ).originalError;
    expect(originalError).toBeInstanceOf(Error);
    expect((originalError as Error).message).toBe(
      "simulated raw output durable commit outage",
    );
    expect(await durableStateStore.readRawOutput(rawOutputRef)).toBeUndefined();
    await removeRunWorkspace(createApplyId);
    const applied = await runner.apply(applyJob);
    expect(applied.outputs).toEqual({
      message: {
        sensitive: false,
        type: "string",
        value: "durable-local-state",
      },
    });
    expect(applied.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(applied.rawOutputRef).toBe(rawOutputRef);
    expect(
      (await durableStateStore.readRawOutput(rawOutputRef))?.outputs,
    ).toEqual(applied.outputs);
    const stateRefHash = createHash("sha256")
      .update(generationOneRef)
      .digest("hex");
    const stateEnvelope = await readFile(
      join(stateArtifactDir, stateRefHash.slice(0, 2), `${stateRefHash}.json`),
      "utf8",
    );
    expect(stateEnvelope).not.toContain("durable-local-state");
    expect(stateEnvelope).not.toContain("stateBase64");
    expect(JSON.parse(stateEnvelope)).toMatchObject({
      version: 2,
      stateRef: generationOneRef,
      workspaceId: "workspace_local",
      subject: { kind: "resource", id: "resource_local" },
      environment: "default",
      createdByRunId: createApplyId,
      action: "apply",
      ciphertextBase64: expect.any(String),
    });

    // Remove every ephemeral runner file. A same-ApplyRun replay must return
    // only from the durable exact target, without a second tofu invocation.
    // Removing the independently addressable raw object additionally proves
    // replay repairs it from the sealed state/replay envelope before the
    // allocated reference is acknowledged again.
    await removeRunWorkspace(createApplyId);
    const rawRefHash = createHash("sha256").update(rawOutputRef).digest("hex");
    await unlink(
      join(
        stateArtifactDir,
        "raw-output",
        rawRefHash.slice(0, 2),
        `${rawRefHash}.json`,
      ),
    );
    expect(
      await runner.apply({
        applyRun: createApplyRun,
        planRun: createApplyPlanRun,
        planArtifact: createPlan.planArtifact,
        runnerProfile: profile,
        executionEvidenceAuthority: testExecutionEvidenceAuthority(),
        generatedRoot,
        sourceArchive,
        outputAllowlist: { message: { from: "message" } },
        stateScope: stateScope(1, generationOneRef),
        rawOutputRef,
        executionEvidenceCommit: {
          stateVersionId: generationOneRef,
          outputId: `output:${createApplyId}`,
        },
      }),
    ).toEqual(applied);
    expect(
      (await durableStateStore.readRawOutput(rawOutputRef))?.outputs,
    ).toEqual(applied.outputs);

    const priorState = {
      generation: 1,
      stateRef: generationOneRef,
      legacyDigestMissing: true as const,
      createdByRunId: createApplyId,
    };
    const destroyPlanRun = localPlanRun(destroyPlanId, "destroy");
    const destroyPlan = await runner.plan({
      planRun: destroyPlanRun,
      runnerProfile: profile,
      variables: {},
      generatedRoot,
      sourceArchive,
      outputAllowlist: { message: { from: "message" } },
      priorState,
      stateScope: stateScope(1, generationOneRef, priorState),
    });
    const generationTwoRef = "artifact:local-state:2";
    const destroyApplyRun = localApplyRun(
      destroyApplyId,
      destroyPlanId,
      "destroy",
    );
    const destroyApplyPlanRun = {
      ...destroyPlanRun,
      planDigest: destroyPlan.planDigest,
      planArtifact: destroyPlan.planArtifact,
    };
    const destroyed = await runner.destroy!({
      applyRun: destroyApplyRun,
      planRun: destroyApplyPlanRun,
      planArtifact: destroyPlan.planArtifact,
      runnerProfile: profile,
      executionEvidenceAuthority: testExecutionEvidenceAuthority(),
      generatedRoot,
      sourceArchive,
      priorState,
      stateScope: stateScope(2, generationTwoRef, priorState),
      executionEvidenceCommit: {
        destroyed: true,
        stateVersionId: generationTwoRef,
      },
    });
    expect(destroyed.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    await removeRunWorkspace(destroyApplyId);
    expect(
      await runner.destroy!({
        applyRun: destroyApplyRun,
        planRun: destroyApplyPlanRun,
        planArtifact: destroyPlan.planArtifact,
        runnerProfile: profile,
        executionEvidenceAuthority: testExecutionEvidenceAuthority(),
        generatedRoot,
        sourceArchive,
        priorState,
        stateScope: stateScope(2, generationTwoRef, priorState),
        executionEvidenceCommit: {
          destroyed: true,
          stateVersionId: generationTwoRef,
        },
      }),
    ).toEqual(destroyed);

    await expect(
      runner.destroy!({
        applyRun: localApplyRun(
          `${destroyApplyId}_other`,
          destroyPlanId,
          "destroy",
        ),
        planRun: destroyPlanRun,
        planArtifact: destroyPlan.planArtifact,
        runnerProfile: profile,
        generatedRoot,
        sourceArchive,
        priorState,
        stateScope: stateScope(2, generationTwoRef, priorState),
        executionEvidenceCommit: {
          destroyed: true,
          stateVersionId: generationTwoRef,
        },
      }),
    ).rejects.toThrow(`already owned by ApplyRun ${destroyApplyId}`);
  } finally {
    await Promise.all(runIds.map(removeRunWorkspace));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("local OpenTofu plan promotes exact post-init provider lockfile bytes", async () => {
  const runId = `plan_lock_${crypto.randomUUID()}`;
  const provider = "registry.opentofu.org/example/provider";
  const lockBytes = new Uint8Array([
    0x70,
    0x72,
    0x6f,
    0x76,
    0x69,
    0x64,
    0x65,
    0x72,
    0x20,
    0x22,
    0xc3,
    0xa9,
    0x22,
    0x20,
    0x7b,
    0x0a,
    0x7d,
    0x0a,
  ]);
  const lockDigest = `sha256:${createHash("sha256")
    .update(lockBytes)
    .digest("hex")}`;
  const planBytes = new TextEncoder().encode("portable-plan");
  const planDigest = `sha256:${createHash("sha256")
    .update(planBytes)
    .digest("hex")}`;
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (
        request.method === "POST" &&
        url.pathname === `/runs/${runId}`
      ) {
        return Response.json({
          status: "succeeded",
          exitCode: 0,
          planDigest,
          planArtifact: {
            kind: "runner-local",
            ref: `runner-local://${runId}/tfplan`,
            digest: planDigest,
          },
          requiredProviders: [provider],
          providerLockDigest: lockDigest,
          providerLockArtifact: {
            kind: "runner-local",
            ref: `runner-local://${runId}/provider-lockfile`,
            digest: lockDigest,
            contentType: "application/vnd.opentofu.lock.hcl",
            sizeBytes: lockBytes.byteLength,
          },
        });
      }
      if (
        request.method === "GET" &&
        url.pathname === `/runs/${runId}/artifacts/tf-lockfile`
      ) {
        return new Response(lockBytes, {
          headers: {
            "content-type": "application/vnd.opentofu.lock.hcl",
            "content-length": String(lockBytes.byteLength),
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const committed: LocalOpenTofuProviderLockfileArtifact[] = [];
  const stateStore = {
    read: async () => undefined,
    commit: async <T>(artifact: T): Promise<T> => artifact,
    readRawOutput: async () => undefined,
    commitRawOutput: async <T>(artifact: T): Promise<T> => artifact,
    commitProviderLockfile: async (
      artifact: LocalOpenTofuProviderLockfileArtifact,
    ) => {
      committed.push(artifact);
      return artifact;
    },
  };
  try {
    const runner = createHttpOpenTofuRunner({
      archiveStore: {
        write: async () => {},
        read: async () => {
          throw new Error("not used");
        },
      },
      stateStore,
      baseUrl: server.url.href,
    });
    const result = await runner.plan({
      planRun: {
        ...localPlanRun(runId, "create"),
        requiredProviders: [provider],
      },
      runnerProfile: createLocalOpenTofuRunnerProfile(),
      variables: {},
    });
    expect(result.providerLockDigest).toBe(lockDigest);
    expect(result.providerLockArtifact).toEqual({
      kind: "local",
      ref: `local-opentofu://runs/${runId}/provider-lockfile`,
      digest: lockDigest,
      contentType: "application/vnd.opentofu.lock.hcl",
      sizeBytes: lockBytes.byteLength,
      createdAt: expect.any(Number),
    });
    expect(committed).toHaveLength(1);
    expect([...committed[0]!.bytes]).toEqual([...lockBytes]);
    expect(
      createHash("sha256").update(committed[0]!.bytes).digest("hex"),
    ).toBe(lockDigest.slice("sha256:".length));
    expect(requests).toEqual([
      `POST /runs/${runId}`,
      `GET /runs/${runId}/artifacts/tf-lockfile`,
    ]);
  } finally {
    server.stop(true);
  }
});

test("local provider lockfile store preserves an empty present artifact separately from absence", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-local-lockfile-empty-"));
  try {
    const ref = "local-opentofu://runs/empty_lockfile/provider-lockfile";
    const bytes = new Uint8Array();
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const store = createFileOpenTofuStateArtifactStore(
      join(tempDir, "state-artifacts"),
      TEST_STATE_CRYPTO,
    );
    const artifact: LocalOpenTofuProviderLockfileArtifact = {
      ref,
      runId: "empty_lockfile",
      digest,
      sizeBytes: 0,
      bytes,
    };
    const committed = await store.commitProviderLockfile!(artifact);
    const reopened = await store.readProviderLockfile!(ref);
    expect(committed.sizeBytes).toBe(0);
    expect(reopened?.digest).toBe(digest);
    expect(reopened?.bytes).toEqual(bytes);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function localPlanRun(id: string, operation: "create" | "destroy") {
  return {
    id,
    workspaceId: "workspace_local",
    source: {
      kind: "git" as const,
      url: "https://example.test/local-runner.git",
      commit: "0123456789abcdef0123456789abcdef01234567",
    },
    sourceDigest: `sha256:${"a".repeat(64)}`,
    operation,
    runnerProfileId: "local-opentofu",
    variablesDigest: `sha256:${"b".repeat(64)}`,
    requiredProviders: [],
    status: "succeeded" as const,
    policy: { effect: "allow" as const, reasons: [] },
    policyDecisionDigest: `sha256:${"c".repeat(64)}`,
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function testExecutionEvidenceAuthority() {
  return {
    controllerArtifact: { digest: `sha256:${"a".repeat(64)}`, immutable: true },
    runnerArtifact: { digest: `sha256:${"b".repeat(64)}`, immutable: true },
    executorArtifact: { digest: `sha256:${"c".repeat(64)}`, immutable: true },
  } as const;
}

function localApplyRun(
  id: string,
  planRunId: string,
  operation: "create" | "destroy",
) {
  return {
    id,
    planRunId,
    workspaceId: "workspace_local",
    operation,
    runnerProfileId: "local-opentofu",
    status: "queued" as const,
    expected: { planRunId },
    stateBackend: { kind: "local" as const, ref: "state://local" },
    stateLock: { status: "pending" as const, backendRef: "state://local" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function stateScope(
  generation: number,
  stateRef: string,
  priorState?: {
    readonly generation: number;
    readonly stateRef: string;
    readonly digest?: string;
    readonly legacyDigestMissing?: true;
    readonly createdByRunId: string;
  },
) {
  return {
    workspaceId: "workspace_local",
    subject: { kind: "resource" as const, id: "resource_local" },
    environment: "default",
    generation,
    stateRef,
    ...(priorState ? { priorState } : {}),
  };
}

async function removeRunWorkspace(runId: string): Promise<void> {
  const workspace = workspaceForRun(runId);
  await rm(workspace.root, { recursive: true, force: true });
  await rm(workspace.depsDir, { recursive: true, force: true });
}

function createArchive(sourceDir: string, archivePath: string): void {
  const result = spawnSync(
    "tar",
    ["--zstd", "-cf", archivePath, "-C", sourceDir, "."],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`tar archive failed: ${result.stderr}`);
  }
}
