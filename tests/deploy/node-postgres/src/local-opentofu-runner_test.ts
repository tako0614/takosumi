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
import {
  OpenTofuRunnerExecutionError,
  OpenTofuRunnerInfrastructureError,
} from "../../../../core/domains/deploy-control/errors.ts";

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

test("HTTP OpenTofu runner preserves status with safe diagnostics for proxy and malformed responses", async () => {
  const proxyMarker = "customer-output-and-token-must-not-leak";
  const proxyHtml = `<html><body>gateway timeout ${proxyMarker}</body></html>`;
  const cases = [
    { status: 503, body: proxyHtml, expectedStatus: "HTTP 503" },
    { status: 200, body: proxyHtml, expectedStatus: "HTTP 200" },
    {
      status: 200,
      body: `${proxyMarker}${"x".repeat(2 * 1024 * 1024 + 1)}`,
      expectedStatus: "HTTP 200",
    },
  ] as const;

  for (const scenario of cases) {
    const runId = `plan_http_error_${scenario.status}_${crypto.randomUUID()}`;
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(scenario.body, {
          status: scenario.status,
          headers: { "content-type": "text/html" },
        }),
    });
    try {
      const runner = createHttpOpenTofuRunner({
        archiveStore: {
          write: async () => {},
          read: async () => new Uint8Array(),
        },
        stateStore: emptyLocalStateStore(),
        baseUrl: server.url.href,
      });
      let failure: unknown;
      try {
        await runner.plan({
          planRun: localPlanRun(runId, "create"),
          runnerProfile: createLocalOpenTofuRunnerProfile(),
          variables: {},
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(OpenTofuRunnerExecutionError);
      expect((failure as Error).message).toContain(scenario.expectedStatus);
      expect((failure as Error).message).not.toContain(proxyMarker);
    } finally {
      server.stop(true);
    }
  }
});

test("HTTP OpenTofu runner allows large successful JSON and preserves body stream aborts", async () => {
  const runId = `plan_http_large_${crypto.randomUUID()}`;
  const digest = `sha256:${"a".repeat(64)}`;
  const largeSuccess = {
    status: "succeeded",
    planDigest: digest,
    planArtifact: {
      kind: "runner-local",
      ref: `runner-local://${runId}/tfplan`,
      digest,
    },
    diagnostics: [],
    stdout: "x".repeat(2 * 1024 * 1024 + 1),
  };
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json(largeSuccess);
    },
  });
  try {
    const runner = createHttpOpenTofuRunner({
      archiveStore: {
        write: async () => {},
        read: async () => new Uint8Array(),
      },
      stateStore: emptyLocalStateStore(),
      baseUrl: server.url.href,
    });
    const result = await runner.plan({
      planRun: localPlanRun(runId, "create"),
      runnerProfile: createLocalOpenTofuRunnerProfile(),
      variables: {},
    });
    expect(result.planDigest).toBe(digest);
  } finally {
    server.stop(true);
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new DOMException("fixture abort", "AbortError"));
        },
      }),
    );
  try {
    const runner = createHttpOpenTofuRunner({
      archiveStore: {
        write: async () => {},
        read: async () => new Uint8Array(),
      },
      stateStore: emptyLocalStateStore(),
      baseUrl: "http://runner.invalid/",
    });
    await expect(
      runner.plan({
        planRun: localPlanRun(`plan_http_abort_${crypto.randomUUID()}`, "create"),
        runnerProfile: createLocalOpenTofuRunnerProfile(),
        variables: {},
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP OpenTofu runner preserves status when a non-JSON error stream is already failed", async () => {
  const runId = `plan_http_failed_stream_${crypto.randomUUID()}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("private proxy detail"));
        },
      }),
      {
        status: 500,
        headers: { "content-type": "text/html" },
      },
    );
  try {
    const runner = createHttpOpenTofuRunner({
      archiveStore: {
        write: async () => {},
        read: async () => new Uint8Array(),
      },
      stateStore: emptyLocalStateStore(),
      baseUrl: "http://runner.invalid/",
    });
    let failure: unknown;
    try {
      await runner.plan({
        planRun: localPlanRun(runId, "create"),
        runnerProfile: createLocalOpenTofuRunnerProfile(),
        variables: {},
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OpenTofuRunnerExecutionError);
    expect((failure as Error).message).toContain("HTTP 500");
    expect((failure as Error).message).not.toContain("private proxy detail");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP OpenTofu runner preserves planned import evidence without accepting lookalike values", async () => {
  const runId = `plan_http_import_${crypto.randomUUID()}`;
  const digest = `sha256:${"a".repeat(64)}`;
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({
      status: "succeeded",
      planDigest: digest,
      planArtifact: {
        kind: "runner-local",
        ref: `runner-local://${runId}/tfplan`,
        digest,
      },
      planResourceChanges: [
        { address: "resource.imported", type: "example_resource", actions: ["no-op"], importing: true },
        { address: "resource.ordinary", type: "example_resource", actions: ["no-op"] },
        { address: "resource.lookalike", type: "example_resource", actions: ["no-op"], importing: "true" },
      ],
    }),
  });
  try {
    const runner = createHttpOpenTofuRunner({
      archiveStore: {
        write: async () => {},
        read: async () => new Uint8Array(),
      },
      stateStore: emptyLocalStateStore(),
      baseUrl: server.url.href,
    });
    const result = await runner.plan({
      planRun: localPlanRun(runId, "create"),
      runnerProfile: createLocalOpenTofuRunnerProfile(),
      variables: {},
    });
    expect(result.planResourceChanges).toEqual([
      { address: "resource.imported", type: "example_resource", actions: ["no-op"], importing: true },
      { address: "resource.ordinary", type: "example_resource", actions: ["no-op"] },
      { address: "resource.lookalike", type: "example_resource", actions: ["no-op"] },
    ]);
  } finally {
    server.stop(true);
  }
});

test("HTTP OpenTofu runner preserves structured error codes without echoing response details", async () => {
  const runId = `plan_http_code_${crypto.randomUUID()}`;
  const privateDetail = "provider output and credential must not be copied";
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        { errorCode: "capacity_exhausted", stderr: privateDetail },
        { status: 503 },
      ),
  });
  try {
    const runner = createHttpOpenTofuRunner({
      archiveStore: {
        write: async () => {},
        read: async () => new Uint8Array(),
      },
      stateStore: emptyLocalStateStore(),
      baseUrl: server.url.href,
    });
    let failure: unknown;
    try {
      await runner.plan({
        planRun: localPlanRun(runId, "create"),
        runnerProfile: createLocalOpenTofuRunnerProfile(),
        variables: {},
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OpenTofuRunnerExecutionError);
    expect((failure as OpenTofuRunnerExecutionError).reason).toBe(
      "capacity_exhausted",
    );
    expect((failure as Error).message).toContain("HTTP 503");
    expect((failure as OpenTofuRunnerExecutionError).detail).not.toContain(
      privateDetail,
    );
    expect((failure as Error).message).not.toContain(privateDetail);
  } finally {
    server.stop(true);
  }
});

async function assertAmbiguousMutationResponse(
  completionStatus: "absent" | "unavailable",
): Promise<void> {
  const runId = `apply_http_ambiguous_${crypto.randomUUID()}`;
  const planRunId = `plan_${runId}`;
  const proxyMarker = "customer-output-and-token-must-not-leak";
  const planBytes = new TextEncoder().encode("immutable-reviewed-plan");
  const planDigest = `sha256:${createHash("sha256")
    .update(planBytes)
    .digest("hex")}`;
  let applyRequests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        return Response.json({ ok: true, mutationCustodyMode: "local-http" });
      }
      if (url.pathname === `/runs/${runId}/completion`) {
        if (applyRequests > 0 && completionStatus === "unavailable") {
          return new Response(`<html>${proxyMarker}</html>`, { status: 503 });
        }
        return Response.json({ status: "absent" }, { status: 404 });
      }
      if (url.pathname === `/runs/${runId}/plan-state-metadata`) {
        return Response.json({ lineage: "", serial: 0 });
      }
      if (url.pathname === `/runs/${runId}/mutation-reservation`) {
        return Response.json({ token: crypto.randomUUID() }, { status: 201 });
      }
      if (
        request.method === "GET" &&
        url.pathname.endsWith("/artifacts/tfplan")
      ) {
        return new Response(planBytes);
      }
      if (request.method === "PUT") return new Response(null, { status: 204 });
      if (request.method === "POST" && url.pathname === `/runs/${runId}`) {
        applyRequests += 1;
        return new Response(`<html>${proxyMarker}</html>`, {
          status: 500,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const runner = createHttpOpenTofuRunner({
      archiveStore: {
        write: async () => {},
        read: async () => new Uint8Array(),
      },
      stateStore: emptyLocalStateStore(),
      baseUrl: server.url.href,
    });
    let failure: unknown;
    try {
      await runner.apply!({
        applyRun: localApplyRun(runId, planRunId, "create"),
        planRun: localPlanRun(planRunId, "create"),
        planArtifact: {
          kind: "runner-local",
          ref: `runner-local://${planRunId}/tfplan`,
          digest: planDigest,
          sizeBytes: planBytes.byteLength,
        },
        runnerProfile: createLocalOpenTofuRunnerProfile(),
        executionEvidenceAuthority: testExecutionEvidenceAuthority(),
        executionEvidenceCommit: {
          stateVersionId: "state_version_fixture",
          outputId: "output_fixture",
        },
        stateScope: {
          workspaceId: "workspace_local",
          subject: { kind: "resource", id: "resource_local" },
          environment: "default",
          generation: 1,
          stateRef: "state://resource_local/1",
        },
      } as never);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OpenTofuRunnerExecutionError);
    expect((failure as Error).message).toContain("HTTP 500");
    expect((failure as OpenTofuRunnerExecutionError).reason).toBe(
      "runner_mutation_indeterminate",
    );
    expect((failure as Error).message).not.toContain(proxyMarker);
    expect((failure as OpenTofuRunnerExecutionError).detail).not.toContain(
      proxyMarker,
    );
    expect(applyRequests).toBe(1);
  } finally {
    server.stop(true);
  }
}

test.each(["absent", "unavailable"] as const)(
  "HTTP OpenTofu runner does not replay an ambiguous mutation response with %s completion",
  assertAmbiguousMutationResponse,
);

test.each([
  { lineage: "canonical-lineage", serial: 8 },
  { lineage: "different-lineage", serial: 7 },
] as const)(
  "local runner rejects a saved Plan with stale state metadata before reserving or restoring state",
  async (planMetadata) => {
    const runId = `apply_stale_${crypto.randomUUID()}`;
    const planRunId = `plan_${runId}`;
    const planBytes = new TextEncoder().encode("captured-reviewed-plan");
    const planDigest = `sha256:${createHash("sha256")
      .update(planBytes)
      .digest("hex")}`;
    const priorStateBytes = new TextEncoder().encode(
      JSON.stringify({ version: 4, lineage: "canonical-lineage", serial: 7 }),
    );
    const priorStateDigest = `sha256:${createHash("sha256")
      .update(priorStateBytes)
      .digest("hex")}`;
    const requests: string[] = [];
    let reserveCount = 0;
    let stateWrites = 0;
    let providerPosts = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}`);
        if (url.pathname === "/healthz") {
          return Response.json({ ok: true, mutationCustodyMode: "local-http" });
        }
        if (url.pathname === `/runs/${runId}/completion`) {
          return Response.json({ status: "absent" }, { status: 404 });
        }
        if (url.pathname === `/runs/${planRunId}/artifacts/tfplan`) {
          return new Response(planBytes);
        }
        if (url.pathname === `/runs/${runId}/plan-state-metadata`) {
          expect(request.method).toBe("POST");
          expect(request.headers.get("x-takosumi-plan-digest")).toBe(planDigest);
          expect(new Uint8Array(await request.arrayBuffer())).toEqual(planBytes);
          return Response.json(planMetadata);
        }
        if (url.pathname === `/runs/${runId}/mutation-reservation`) {
          reserveCount += 1;
          return Response.json({ token: crypto.randomUUID() }, { status: 201 });
        }
        if (request.method === "PUT") {
          stateWrites += 1;
          return new Response(null, { status: 204 });
        }
        if (request.method === "POST" && url.pathname === `/runs/${runId}`) {
          providerPosts += 1;
          return Response.json({ status: "succeeded" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const runner = createHttpOpenTofuRunner({
        archiveStore: {
          write: async () => {},
          read: async () => new Uint8Array(),
        },
        stateStore: {
          ...emptyLocalStateStore(),
          read: async (stateRef: string) => stateRef === "state://resource_local/1"
            ? {
              stateRef,
              workspaceId: "workspace_local",
              subject: { kind: "resource", id: "resource_local" },
              environment: "default",
              generation: 1,
              createdByRunId: "apply_prior",
              action: "apply" as const,
              stateDigest: priorStateDigest,
              stateBytes: priorStateBytes,
              result: {} as never,
            }
            : undefined,
        },
        baseUrl: server.url.href,
      });
      await expect(runner.apply!({
        applyRun: localApplyRun(runId, planRunId, "create"),
        planRun: { ...localPlanRun(planRunId, "create"), planDigest, planArtifact: {
          kind: "runner-local",
          ref: `runner-local://${planRunId}/tfplan`,
          digest: planDigest,
          sizeBytes: planBytes.byteLength,
        } },
        planArtifact: {
          kind: "runner-local",
          ref: `runner-local://${planRunId}/tfplan`,
          digest: planDigest,
          sizeBytes: planBytes.byteLength,
        },
        runnerProfile: createLocalOpenTofuRunnerProfile(),
        executionEvidenceAuthority: testExecutionEvidenceAuthority(),
        executionEvidenceCommit: {
          stateVersionId: "state_version_fixture",
          outputId: "output_fixture",
        },
        stateScope: {
          ...stateScope(2, "state://resource_local/2", {
            generation: 1,
            stateRef: "state://resource_local/1",
            digest: priorStateDigest,
            createdByRunId: "apply_prior",
          }),
        },
      } as never)).rejects.toThrow("local saved Plan metadata preflight failed");
      expect(reserveCount).toBe(0);
      expect(stateWrites).toBe(0);
      expect(providerPosts).toBe(0);
      expect(requests).not.toContain(`PUT /runs/${runId}/artifacts/tfstate`);
    } finally {
      server.stop(true);
    }
  },
);

test("local runner permits a legacy missing-size first saved Plan against absent canonical state", async () => {
  const runId = `apply_initial_${crypto.randomUUID()}`;
  const planRunId = `plan_${runId}`;
  const planBytes = new TextEncoder().encode("captured-initial-plan");
  const planDigest = `sha256:${createHash("sha256")
    .update(planBytes)
    .digest("hex")}`;
  let reserveCount = 0;
  let restoredPlanBytes: Uint8Array | undefined;
  let applyPostCount = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        return Response.json({ ok: true, mutationCustodyMode: "local-http" });
      }
      if (url.pathname === `/runs/${runId}/completion`) {
        return Response.json({ status: "absent" }, { status: 404 });
      }
      if (url.pathname === `/runs/${planRunId}/artifacts/tfplan`) {
        return new Response(planBytes);
      }
      if (url.pathname === `/runs/${runId}/plan-state-metadata`) {
        expect(request.headers.get("x-takosumi-plan-digest")).toBe(planDigest);
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(planBytes);
        return Response.json({ lineage: "", serial: 0 });
      }
      if (url.pathname === `/runs/${runId}/mutation-reservation`) {
        reserveCount += 1;
        return Response.json({ token: crypto.randomUUID() }, { status: 201 });
      }
      if (request.method === "PUT" && url.pathname.endsWith("/artifacts/tfplan")) {
        restoredPlanBytes = new Uint8Array(await request.arrayBuffer());
        return new Response(null, { status: 204 });
      }
      if (request.method === "POST" && url.pathname === `/runs/${runId}`) {
        applyPostCount += 1;
        return new Response("provider runner unavailable", { status: 503 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const runner = createHttpOpenTofuRunner({
      archiveStore: { write: async () => {}, read: async () => new Uint8Array() },
      stateStore: emptyLocalStateStore(),
      baseUrl: server.url.href,
    });
    await expect(runner.apply!({
      applyRun: localApplyRun(runId, planRunId, "create"),
      planRun: localPlanRun(planRunId, "create"),
      planArtifact: {
        kind: "runner-local",
        ref: `runner-local://${planRunId}/tfplan`,
        digest: planDigest,
      },
      runnerProfile: createLocalOpenTofuRunnerProfile(),
      executionEvidenceAuthority: testExecutionEvidenceAuthority(),
      executionEvidenceCommit: {
        stateVersionId: "state_version_fixture",
        outputId: "output_fixture",
      },
      stateScope: stateScope(1, "state://resource_local/1"),
    } as never)).rejects.toBeInstanceOf(OpenTofuRunnerExecutionError);
    expect(reserveCount).toBe(1);
    expect(restoredPlanBytes).toEqual(planBytes);
    expect(applyPostCount).toBe(1);
  } finally {
    server.stop(true);
  }
});

test("local runner restores the exact captured saved Plan and prior state bytes", async () => {
  const runId = `apply_same_bytes_${crypto.randomUUID()}`;
  const planRunId = `plan_${runId}`;
  const planBytes = new TextEncoder().encode("captured-reviewed-plan-with-prior-state");
  const planDigest = `sha256:${createHash("sha256")
    .update(planBytes)
    .digest("hex")}`;
  const priorStateBytes = new TextEncoder().encode(
    '{ "version": 4, "lineage": "stable-lineage", "serial": 12 }\n',
  );
  const priorStateDigest = `sha256:${createHash("sha256")
    .update(priorStateBytes)
    .digest("hex")}`;
  let priorStateReads = 0;
  let restoredPlanBytes: Uint8Array | undefined;
  let restoredStateBytes: Uint8Array | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        return Response.json({ ok: true, mutationCustodyMode: "local-http" });
      }
      if (url.pathname === `/runs/${runId}/completion`) {
        return Response.json({ status: "absent" }, { status: 404 });
      }
      if (url.pathname === `/runs/${planRunId}/artifacts/tfplan`) {
        return new Response(planBytes);
      }
      if (url.pathname === `/runs/${runId}/plan-state-metadata`) {
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(planBytes);
        return Response.json({ lineage: "stable-lineage", serial: 12 });
      }
      if (url.pathname === `/runs/${runId}/mutation-reservation`) {
        return Response.json({ token: crypto.randomUUID() }, { status: 201 });
      }
      if (request.method === "PUT" && url.pathname.endsWith("/artifacts/tfstate")) {
        restoredStateBytes = new Uint8Array(await request.arrayBuffer());
        return new Response(null, { status: 204 });
      }
      if (request.method === "PUT" && url.pathname.endsWith("/artifacts/tfplan")) {
        restoredPlanBytes = new Uint8Array(await request.arrayBuffer());
        return new Response(null, { status: 204 });
      }
      if (request.method === "POST" && url.pathname === `/runs/${runId}`) {
        return new Response("provider runner unavailable", { status: 503 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const runner = createHttpOpenTofuRunner({
      archiveStore: { write: async () => {}, read: async () => new Uint8Array() },
      stateStore: {
        ...emptyLocalStateStore(),
        async read(stateRef: string) {
          if (stateRef === "state://resource_local/1") priorStateReads += 1;
          return stateRef === "state://resource_local/1"
            ? {
              stateRef,
              workspaceId: "workspace_local",
              subject: { kind: "resource", id: "resource_local" },
              environment: "default",
              generation: 1,
              createdByRunId: "apply_prior",
              action: "apply" as const,
              stateDigest: priorStateDigest,
              stateBytes: priorStateBytes,
              result: {} as never,
            }
            : undefined;
        },
      },
      baseUrl: server.url.href,
    });
    await expect(runner.apply!({
      applyRun: localApplyRun(runId, planRunId, "create"),
      planRun: localPlanRun(planRunId, "create"),
      planArtifact: {
        kind: "runner-local",
        ref: `runner-local://${planRunId}/tfplan`,
        digest: planDigest,
        sizeBytes: planBytes.byteLength,
      },
      runnerProfile: createLocalOpenTofuRunnerProfile(),
      executionEvidenceAuthority: testExecutionEvidenceAuthority(),
      executionEvidenceCommit: {
        stateVersionId: "state_version_fixture",
        outputId: "output_fixture",
      },
      stateScope: stateScope(2, "state://resource_local/2", {
        generation: 1,
        stateRef: "state://resource_local/1",
        digest: priorStateDigest,
        createdByRunId: "apply_prior",
      }),
    } as never)).rejects.toBeInstanceOf(OpenTofuRunnerExecutionError);
    expect(priorStateReads).toBe(1);
    expect(restoredPlanBytes).toEqual(planBytes);
    expect(restoredStateBytes).toEqual(priorStateBytes);
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

function emptyLocalStateStore() {
  return {
    read: async () => undefined,
    commit: async <T>(artifact: T): Promise<T> => artifact,
    readRawOutput: async () => undefined,
    commitRawOutput: async <T>(artifact: T): Promise<T> => artifact,
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
