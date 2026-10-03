import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRunnerRequestWithDependencies } from "../../../runner/entrypoint.ts";
import { RUN_ROOT } from "../../../runner/lib/constants.ts";
import { readModuleDir, workspaceForRun } from "../../../runner/lib/artifacts.ts";
import {
  mutationRequestDigest,
  reserveLocalMutation,
} from "../../../runner/lib/run_completion.ts";

import type { SourceSnapshot } from "../../../contract/sources.ts";
import type {
  OpenTofuRestoreExecutionControl,
  OpenTofuRestoreSourceState,
} from "../../../core/domains/deploy-control/mod.ts";
import {
  createHttpOpenTofuRunner,
  createLocalOpenTofuRunner,
  type LocalOpenTofuStateArtifact,
} from "../../../deploy/node-postgres/src/local-opentofu-runner.ts";

const FIXTURE_EXECUTION_EVIDENCE_AUTHORITY = {
  controllerArtifact: { digest: `sha256:${"a".repeat(64)}`, immutable: true },
  runnerArtifact: { digest: `sha256:${"b".repeat(64)}`, immutable: true },
  executorArtifact: { digest: `sha256:${"c".repeat(64)}`, immutable: true },
} as const;
const handleRunnerRequest = (request: Request) =>
  handleRunnerRequestWithDependencies(request, {
    mutationCustodyMode: "local-http",
    localPreparationV2: false,
  });
const handleRunnerRequestV2 = (request: Request) =>
  handleRunnerRequestWithDependencies(request, {
    mutationCustodyMode: "local-http",
    localPreparationV2: true,
  });

test("local HTTP mutation mode mismatch refuses before completion, preparation or dispatch", async () => {
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    return Response.json({ ok: true, mutationCustodyMode: "cloudflare-do" });
  } });
  try {
    const runner = createHttpOpenTofuRunner({ stateStore: unusedStateStore,
      archiveStore: { write: async () => {}, read: async () => { throw new Error("must not prepare"); } }, baseUrl: server.url.href });
    await expect(runner.apply({ applyRun: { id: "apply_mode" }, planRun: { id: "plan_mode" },
      planArtifact: { kind: "runner-local", ref: "runner-local://plan_mode/tfplan", digest: `sha256:${"a".repeat(64)}` },
      stateScope: { workspaceId: "workspace_mode", subject: { kind: "resource", id: "resource_mode" }, environment: "integration", generation: 1, stateRef: "state://mode" },
    } as Parameters<typeof runner.apply>[0])).rejects.toMatchObject({ name: "OpenTofuRunnerExecutionError", reason: "runner_mutation_custody_mode_mismatch" });
    expect(requests).toEqual(["GET /healthz"]);
  } finally { server.stop(true); }
});

test("local OpenTofu runner restores an exact source into an operation-scoped immutable artifact", async () => {
  const stateBytes = new TextEncoder().encode('{"version":4,"serial":1}');
  const stateDigest = await sha256(stateBytes);
  const source: LocalOpenTofuStateArtifact = {
    stateRef: "runner-local://apply/source",
    workspaceId: "workspace_1",
    subject: { kind: "capsule", id: "capsule_1" },
    environment: "production",
    generation: 1,
    createdByRunId: "apply_source",
    action: "apply",
    stateDigest,
    stateBytes,
    result: { stateDigest },
  };
  let stored: LocalOpenTofuStateArtifact | undefined;
  const stateStore = {
    read: async (stateRef: string) => {
      if (stateRef === source.stateRef) return source;
      return stored?.stateRef === stateRef ? stored : undefined;
    },
    commit: async (artifact: LocalOpenTofuStateArtifact) => {
      stored = artifact;
      return artifact;
    },
    readRawOutput: async () => undefined,
    commitRawOutput: async <T>(artifact: T): Promise<T> => artifact,
  };
  const runner = createLocalOpenTofuRunner({
    archiveStore: {
      write: async () => {},
      read: async () => new Uint8Array(),
    },
    stateStore,
  });
  const job = {
    runId: "restore_1",
    stateScope: {
      workspaceId: "workspace_1",
      subject: { kind: "capsule" as const, id: "capsule_1" },
      environment: "production",
      generation: 2,
      stateRef: "workspaces/workspace_1/capsules/capsule_1/state-00000002",
    },
    sourceState: {
      stateVersionId: "state_version_1",
      workspaceId: source.workspaceId,
      capsuleId: source.subject.id,
      environment: source.environment,
      generation: source.generation,
      stateRef: source.stateRef,
      digest: stateDigest,
      createdByRunId: source.createdByRunId,
    },
  } as const;
  const sourceAuthority = {
    readExact: async () => job.sourceState,
  };

  const result = await runner.restore(job, { sourceAuthority });
  expect(result.state.generation).toBe(2);
  expect(result.state.logicalTargetStateRef).toBe(job.stateScope.stateRef);
  expect(result.state.stateRef).toBe(job.stateScope.stateRef);
  expect(result.state.runId).toBe(job.runId);
  expect(result.state.digest).toBe(stateDigest);
  expect(result.state.restoreAuthority).toEqual({
    kind: "takosumi.runner-restore-ack@v1",
    version: 1,
    fence: 1,
    operationId: "local-restore:restore_1",
    stateEtag: stateDigest,
  });
  expect(stored?.stateBytes).toEqual(stateBytes);
  expect((await runner.restore(job, { sourceAuthority })).state).toEqual(
    result.state,
  );
});

test("local OpenTofu runner rejects every mismatched Restore source identity", async () => {
  const stateBytes = new TextEncoder().encode('{"version":4,"serial":1}');
  const stateDigest = await sha256(stateBytes);
  const source: LocalOpenTofuStateArtifact = {
    stateRef: "runner-local://apply/exact-source",
    workspaceId: "workspace_exact",
    subject: { kind: "capsule", id: "capsule_exact" },
    environment: "production",
    generation: 1,
    createdByRunId: "apply_exact",
    action: "apply",
    stateDigest,
    stateBytes,
    result: { stateDigest },
  };
  const stateStore = {
    read: async (stateRef: string) =>
      stateRef === source.stateRef ? source : undefined,
    commit: async (artifact: LocalOpenTofuStateArtifact) => artifact,
    readRawOutput: async () => undefined,
    commitRawOutput: async <T>(artifact: T): Promise<T> => artifact,
  };
  const runner = createLocalOpenTofuRunner({
    archiveStore: {
      write: async () => {},
      read: async () => new Uint8Array(),
    },
    stateStore,
  });
  const baseJob = {
    runId: "restore_exact",
    stateScope: {
      workspaceId: source.workspaceId,
      subject: source.subject,
      environment: source.environment,
      generation: 2,
      stateRef: "workspaces/workspace_exact/capsules/capsule_exact/state-2",
    },
    sourceState: {
      stateVersionId: "state-version-exact",
      workspaceId: source.workspaceId,
      capsuleId: source.subject.id,
      environment: source.environment,
      generation: source.generation,
      stateRef: source.stateRef,
      digest: source.stateDigest,
      createdByRunId: source.createdByRunId,
    },
  } as const;
  const sourceAuthority = {
    readExact: async () => baseJob.sourceState,
  };
  const mismatches = [
    {
      name: "generation",
      sourceState: { ...baseJob.sourceState, generation: 0 },
    },
    {
      name: "creator",
      sourceState: {
        ...baseJob.sourceState,
        createdByRunId: "apply_other",
      },
    },
    {
      name: "ref",
      sourceState: {
        ...baseJob.sourceState,
        stateRef: "runner-local://apply/other-source",
      },
    },
    {
      name: "digest",
      sourceState: {
        ...baseJob.sourceState,
        digest: `sha256:${"0".repeat(64)}`,
      },
    },
    {
      name: "cross-scope",
      sourceState: {
        ...baseJob.sourceState,
        workspaceId: "workspace_other",
      },
    },
  ] as const;
  for (const mismatch of mismatches) {
    await expect(
      runner.restore(
        { ...baseJob, sourceState: mismatch.sourceState },
        { sourceAuthority },
      ),
      mismatch.name,
    ).rejects.toThrow();
  }
});

test("local OpenTofu runner fails closed before a target commit without exact source authority", async () => {
  const stateBytes = new TextEncoder().encode('{"version":4,"serial":1}');
  const stateDigest = await sha256(stateBytes);
  const source: LocalOpenTofuStateArtifact = {
    stateRef: "runner-local://apply/authority-source",
    workspaceId: "workspace_authority",
    subject: { kind: "capsule", id: "capsule_authority" },
    environment: "production",
    generation: 1,
    createdByRunId: "apply_authority",
    action: "apply",
    stateDigest,
    stateBytes,
    result: { stateDigest },
  };
  let commits = 0;
  const stateStore = {
    read: async (stateRef: string) =>
      stateRef === source.stateRef ? source : undefined,
    commit: async (artifact: LocalOpenTofuStateArtifact) => {
      commits += 1;
      return artifact;
    },
    readRawOutput: async () => undefined,
    commitRawOutput: async <T>(artifact: T): Promise<T> => artifact,
  };
  const runner = createLocalOpenTofuRunner({
    archiveStore: {
      write: async () => {},
      read: async () => new Uint8Array(),
    },
    stateStore,
  });
  const sourceState: OpenTofuRestoreSourceState = {
    stateVersionId: "state-authority",
    workspaceId: source.workspaceId,
    capsuleId: source.subject.id,
    environment: source.environment,
    generation: source.generation,
    stateRef: source.stateRef,
    digest: source.stateDigest,
    createdByRunId: source.createdByRunId,
  };
  const job = {
    runId: "restore_authority",
    stateScope: {
      workspaceId: source.workspaceId,
      subject: source.subject,
      environment: source.environment,
      generation: 2,
      stateRef:
        "workspaces/workspace_authority/capsules/capsule_authority/state-2",
    },
    sourceState,
  } as const;
  const forged = (
    patch: Partial<OpenTofuRestoreSourceState>,
  ): OpenTofuRestoreSourceState => ({ ...sourceState, ...patch });
  const cases: readonly {
    readonly name: string;
    readonly control?: OpenTofuRestoreExecutionControl;
  }[] = [
    { name: "missing" },
    {
      name: "undefined",
      control: { sourceAuthority: { readExact: async () => undefined } },
    },
    {
      name: "outage",
      control: {
        sourceAuthority: {
          readExact: async () => {
            throw new Error("source store unavailable");
          },
        },
      },
    },
    {
      name: "forged-id",
      control: {
        sourceAuthority: {
          readExact: async () => forged({ stateVersionId: "state-forged" }),
        },
      },
    },
    {
      name: "forged-field",
      control: {
        sourceAuthority: {
          readExact: async () =>
            forged({
              workspaceId: "workspace-forged",
              capsuleId: "capsule-forged",
              environment: "staging",
              generation: 0,
              stateRef: "runner-local://apply/forged",
              digest: `sha256:${"0".repeat(64)}`,
              createdByRunId: "apply-forged",
            }),
        },
      },
    },
  ];
  for (const entry of cases) {
    await expect(
      // This case intentionally exercises malformed runtime input. The public
      // boundary requires control at compile time; the cast keeps the
      // fail-closed missing-authority regression covered without weakening it.
      runner.restore(job, entry.control as OpenTofuRestoreExecutionControl),
      entry.name,
    ).rejects.toThrow();
  }
  expect(commits).toBe(0);
});

test("local OpenTofu runner passes modulePath to compatibility_check", async () => {
  const archiveBytes = new TextEncoder().encode("archive");
  const archiveDigest = await sha256(archiveBytes);
  const requests: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (
        request.method === "PUT" &&
        url.pathname === "/runs/compat_1/source-archive/restore"
      ) {
        return new Response(null, { status: 204 });
      }
      if (request.method === "POST" && url.pathname === "/runs/compat_1") {
        requests.push(await request.json());
        return Response.json({ files: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const runner = createHttpOpenTofuRunner({
      stateStore: unusedStateStore,
      archiveStore: {
        write: async () => {},
        read: async () => archiveBytes,
      },
      baseUrl: server.url.href,
    });

    await runner.readCapsuleSourceFiles({
      runId: "compat_1",
      sourceSnapshot: sourceSnapshot(archiveDigest),
      modulePath: "deploy/opentofu",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: "takosumi.opentofu-run@v1",
      action: "compatibility_check",
      runId: "compat_1",
      request: {
        source: {
          modulePath: "deploy/opentofu",
        },
      },
    });
  } finally {
    server.stop(true);
  }
});

test("HTTP OpenTofu runner carries SourceSnapshot identity into release activation", async () => {
  const archiveBytes = new TextEncoder().encode("release source archive");
  const archiveDigest = await sha256(archiveBytes);
  const requests: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (
        request.method === "PUT" &&
        url.pathname === "/runs/release_1/source-archive/restore"
      ) {
        return new Response(null, { status: 204 });
      }
      if (request.method === "POST" && url.pathname === "/runs/release_1") {
        requests.push(await request.json());
        return Response.json({
          runId: "release_1",
          action: "release",
          status: "succeeded",
          exitCode: 0,
          commandCount: 1,
          stdout: "release ok",
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const runner = createHttpOpenTofuRunner({
      stateStore: unusedStateStore,
      archiveStore: {
        write: async () => {},
        read: async () => archiveBytes,
      },
      baseUrl: server.url.href,
    });
    const snapshot = sourceSnapshot(archiveDigest);
    const result = await runner.release({
      runId: "release_1",
      applyRunId: "apply_1",
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      stateVersionId: "state_1",
      sourceSnapshot: snapshot,
      nonSensitiveOutputs: { public_url: "https://app.example.test" },
      providerConfigurations: {
        format: "takosumi.provider-configurations@v1",
        providers: [],
      },
      commands: [
        {
          id: "retire-runtime",
          phase: "pre_destroy",
          command: ["bun", "run", "retire"],
        },
      ],
    });

    expect(result).toEqual({
      status: "succeeded",
      runId: "release_1",
      commandCount: 1,
      stdout: "release ok",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      action: "release",
      request: {
        activation: {
          applyRunId: "apply_1",
          workspaceId: "workspace_1",
          capsuleId: "capsule_1",
          stateVersionId: "state_1",
          sourceSnapshotId: "snap_1",
          sourceCommit: snapshot.resolvedCommit,
        },
      },
    });
  } finally {
    server.stop(true);
  }
});

test("HTTP OpenTofu runner preserves source sync reuse and repository metadata", async () => {
  const archiveBytes = new TextEncoder().encode("source archive");
  const archiveDigest = await sha256(archiveBytes);
  const requests: unknown[] = [];
  const writes: Array<{ key: string; bytes: Uint8Array }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/runs/sync_1") {
        requests.push(await request.json());
        return Response.json({
          resolvedCommit: "fedcba9876543210fedcba9876543210fedcba98",
          sourceArchive: {
            ref: "workspaces/workspace_1/sources/source_1/archive.tar.zst",
            digest: archiveDigest,
            sizeBytes: archiveBytes.byteLength,
          },
          repositoryInstallMetadata: {
            status: "present",
            text: '{"name":"Capsule"}',
          },
          repositoryManifest: {
            status: "present",
            digest: `sha256:${"c".repeat(64)}`,
            document: {
              apiVersion: "takosumi.com/v1",
              kind: "Repository",
              install: { modules: { ".": { inputs: [] } } },
            },
          },
          repositoryModules: {
            status: "ready",
            scopePath: ".",
            modules: [
              {
                path: ".",
                providerPackages: [],
                rootProviderRequirements: [],
              },
            ],
          },
          phaseTimings: [
            {
              phase: "archive",
              startedAt: "2026-07-16T00:00:00.000Z",
              finishedAt: "2026-07-16T00:00:00.010Z",
              durationMs: 10,
            },
          ],
        });
      }
      if (
        request.method === "GET" &&
        url.pathname === "/runs/sync_1/artifacts/source-archive"
      ) {
        return new Response(archiveBytes);
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const runner = createHttpOpenTofuRunner({
      stateStore: unusedStateStore,
      archiveStore: {
        write: async (key, bytes) => writes.push({ key, bytes }),
        read: async () => {
          throw new Error("not used");
        },
      },
      baseUrl: server.url.href,
    });
    const reuseSnapshot = {
      id: "snapshot_0",
      resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
      archiveRef: "workspaces/workspace_1/sources/source_1/old.tar.zst",
      archiveDigest,
      archiveSizeBytes: archiveBytes.byteLength,
      repositoryModules: {
        status: "ready",
        scopePath: ".",
        modules: [],
      },
    };

    const result = await runner.sourceSync({
      runId: "sync_1",
      workspaceId: "workspace_1",
      sourceId: "source_1",
      source: {
        url: "https://example.test/capsule.git",
        ref: "main",
        path: ".",
      },
      archiveRef: "workspaces/workspace_1/sources/source_1/archive.tar.zst",
      reuseSnapshot,
    });

    expect(requests[0]).toMatchObject({
      action: "source_sync",
      request: { reuseSnapshot },
    });
    expect(result).toEqual({
      resolvedCommit: "fedcba9876543210fedcba9876543210fedcba98",
      archiveDigest,
      archiveSizeBytes: archiveBytes.byteLength,
      archiveRef: "workspaces/workspace_1/sources/source_1/archive.tar.zst",
      repositoryInstallMetadata: {
        status: "present",
        text: '{"name":"Capsule"}',
      },
      repositoryManifest: {
        status: "present",
        digest: `sha256:${"c".repeat(64)}`,
        document: {
          apiVersion: "takosumi.com/v1",
          kind: "Repository",
          install: { modules: { ".": { inputs: [] } } },
        },
      },
      repositoryModules: {
        status: "ready",
        scopePath: ".",
        modules: [
          { path: ".", providerPackages: [], rootProviderRequirements: [] },
        ],
      },
      phaseTimings: [
        {
          phase: "archive",
          startedAt: "2026-07-16T00:00:00.000Z",
          finishedAt: "2026-07-16T00:00:00.010Z",
          durationMs: 10,
        },
      ],
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.key).toBe(
      "workspaces/workspace_1/sources/source_1/archive.tar.zst",
    );
    expect(writes[0]?.bytes).toEqual(archiveBytes);
  } finally {
    server.stop(true);
  }
});

test("HTTP OpenTofu runner keeps an unchanged object-storage source archive without refetching it", async () => {
  const archiveBytes = new TextEncoder().encode("reused source archive");
  const archiveDigest = await sha256(archiveBytes);
  const resolvedCommit = "0123456789abcdef0123456789abcdef01234567";
  const archiveRef = "workspaces/workspace_1/sources/source_1/previous.tar.zst";
  const reuseSnapshot = {
    id: "snapshot_previous",
    resolvedCommit,
    archiveRef,
    archiveDigest,
    archiveSizeBytes: archiveBytes.byteLength,
    repositoryModules: {
      status: "ready",
      scopePath: ".",
      modules: [],
    },
  };
  const requests: string[] = [];
  const writes: Array<{ key: string; bytes: Uint8Array }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (request.method === "POST" && url.pathname === "/runs/sync_reuse") {
        return Response.json({
          resolvedCommit,
          archiveDigest,
          archiveSizeBytes: archiveBytes.byteLength,
          sourceArchive: {
            kind: "object-storage",
            ref: archiveRef,
            digest: archiveDigest,
            sizeBytes: archiveBytes.byteLength,
            reusedFromSnapshotId: reuseSnapshot.id,
          },
          repositoryModules: reuseSnapshot.repositoryModules,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const runner = createHttpOpenTofuRunner({
      stateStore: unusedStateStore,
      archiveStore: {
        write: async (key, bytes) => writes.push({ key, bytes }),
        read: async () => {
          throw new Error("not used");
        },
      },
      baseUrl: server.url.href,
    });

    const result = await runner.sourceSync({
      runId: "sync_reuse",
      workspaceId: "workspace_1",
      sourceId: "source_1",
      source: {
        url: "https://example.test/capsule.git",
        ref: "main",
        path: ".",
      },
      archiveRef: "workspaces/workspace_1/sources/source_1/replacement.tar.zst",
      reuseSnapshot,
    });

    expect(result).toEqual({
      resolvedCommit,
      archiveDigest,
      archiveSizeBytes: archiveBytes.byteLength,
      archiveRef,
      repositoryModules: reuseSnapshot.repositoryModules,
    });
    expect(requests).toEqual(["POST /runs/sync_reuse"]);
    expect(writes).toHaveLength(0);
  } finally {
    server.stop(true);
  }
});

test.each(["v1", "v2", "v2-ack-loss", "v2-ack-loss-result-mismatch", "v2-ack-loss-output-mismatch", "v2-ack-loss-state-mismatch", "v2-ack-loss-state-missing"] as const)("HTTP OpenTofu runner carries direct provider evidence through apply and destroy commits with %s custody", async (variant) => {
  const custodyVersion = variant === "v1" ? "v1" : "v2";
  const ackLoss = variant.startsWith("v2-ack-loss");
  const provider = "registry.opentofu.org/example/direct";
  const installedDigest = `sha256:${"d".repeat(64)}`;
  const planBytes = new TextEncoder().encode("reviewed direct-provider plan");
  const planDigest = await sha256(planBytes);
  const lockBytes = new TextEncoder().encode("# reviewed provider lock\n");
  const lockDigest = await sha256(lockBytes);
  const stateBytes = new TextEncoder().encode('{"serial":1}');
  const installation = {
    provider,
    mirrored: false,
    installationMethod: "direct",
    attested: true,
    attestationMethod: "runner_observed_installed_artifact",
    installedPath: "/runner/.terraform/providers/example/direct",
    installedDigest,
  };
  const requests: string[] = [];
  const restoreMarkers: (string | null)[] = [];
  const attempts = new Map<string, string>();
  const completed = new Map<string, Record<string, unknown>>();
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz")
        return Response.json({
          ok: true,
          mutationCustodyMode: "local-http",
          ...(custodyVersion === "v2" ? { capabilities: ["takosumi.local-mutation-preparation@v2"] } : {}),
        });
      requests.push(`${request.method} ${url.pathname}`);
      if (request.method === "POST" &&
          /^\/runs\/(apply_http_direct|destroy_http_direct)\/plan-state-metadata$/u.test(url.pathname)) {
        return Response.json({ lineage: "", serial: 0 });
      }
      if (
        request.method === "PUT" &&
        new RegExp(`^/runs/(apply_http_direct|destroy_http_direct)/mutation-${custodyVersion === "v2" ? "preparation" : "reservation"}$`, "u").test(
          url.pathname,
        )
      ) {
        if (custodyVersion === "v2") {
          const reservation = await request.json() as { runId: string; attemptId: string };
          attempts.set(reservation.runId, reservation.attemptId);
        }
        return Response.json(
          custodyVersion === "v2" ? { epoch: 1 } : { token: "00000000-0000-4000-8000-000000000000" },
          { status: 201 },
        );
      }
      if (
        request.method === "GET" &&
        /^\/runs\/(apply_http_direct|destroy_http_direct)\/completion$/u.test(
          url.pathname,
        )
      ) {
        const runId = url.pathname.split("/")[2]!;
        const result = completed.get(runId);
        if (ackLoss && result) {
          if (!request.headers.has("x-takosumi-preparation-attempt"))
            return Response.json({ errorCode: "runner_mutation_indeterminate" }, { status: 409 });
          expect(request.headers.get("x-takosumi-preparation-attempt")).toBe(attempts.get(runId));
          expect(request.headers.get("x-takosumi-preparation-epoch")).toBe("1");
          expect(request.headers.get("x-takosumi-provider-lock-restore-digest")).toBe(lockDigest);
          const projection = {
            runId,
            action: runId.startsWith("apply") ? "apply" : "destroy",
            status: "succeeded",
            exitCode: 0,
            ...(result.outputs ? { outputs: result.outputs } : {}),
            providerInstallation: result.providerInstallation,
          };
          return Response.json({
            kind: "takosumi.local-mutation-success-readback@v2",
            result: projection,
            resultDigest: variant === "v2-ack-loss-result-mismatch"
              ? `sha256:${"a".repeat(64)}`
              : await sha256(new TextEncoder().encode(JSON.stringify(projection))),
            stateDigest: variant === "v2-ack-loss-state-mismatch"
              ? `sha256:${"b".repeat(64)}`
              : await sha256(stateBytes),
            outputDigest: variant === "v2-ack-loss-output-mismatch"
              ? `sha256:${"c".repeat(64)}`
              : await sha256(new TextEncoder().encode(JSON.stringify(projection.outputs ?? {}))),
          });
        }
        return Response.json({ status: "absent" }, { status: 404 });
      }
      const planArtifactMatch =
        /^\/runs\/(plan_http_apply|plan_http_destroy)\/artifacts\/tfplan$/u.exec(
          url.pathname,
        );
      if (request.method === "GET" && planArtifactMatch) {
        return new Response(planBytes, {
          headers: { "content-type": "application/vnd.opentofu.plan" },
        });
      }
      if (
        request.method === "PUT" &&
        /^\/runs\/(apply_http_direct|destroy_http_direct)\/artifacts\/tfplan$/u.test(
          url.pathname,
        )
      ) {
        if (custodyVersion === "v2") {
          expect(request.headers.get("x-takosumi-preparation-attempt")).toMatch(/^[0-9a-f-]{36}$/u);
          expect(request.headers.get("x-takosumi-preparation-epoch")).toBe("1");
        }
        return Response.json({ ok: true });
      }
      if (
        request.method === "PUT" &&
        /^\/runs\/(apply_http_direct|destroy_http_direct)\/provider-lockfile\/restore$/u.test(
          url.pathname,
        )
      ) {
        if (custodyVersion === "v2") {
          expect(request.headers.get("x-takosumi-preparation-attempt")).toMatch(/^[0-9a-f-]{36}$/u);
          expect(request.headers.get("x-takosumi-preparation-epoch")).toBe("1");
        }
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(lockBytes);
        return Response.json({
          digest: lockDigest,
          sizeBytes: lockBytes.byteLength,
        });
      }
      const runMatch =
        /^\/runs\/(apply_http_direct|destroy_http_direct)$/u.exec(url.pathname);
      if (request.method === "POST" && runMatch) {
        if (custodyVersion === "v2") {
          expect(request.headers.get("x-takosumi-preparation-attempt")).toMatch(/^[0-9a-f-]{36}$/u);
          expect(request.headers.get("x-takosumi-preparation-epoch")).toBe("1");
        }
        restoreMarkers.push(
          request.headers.get("x-takosumi-provider-lock-restore-digest"),
        );
        const result = {
          status: "succeeded",
          exitCode: 0,
          ...(runMatch[1] === "apply_http_direct"
            ? {
                outputs: {
                  public_url: {
                    sensitive: false,
                    type: "string",
                    value: "https://direct.example",
                  },
                },
              }
            : {}),
          providerInstallation: [installation],
        };
        completed.set(runMatch[1]!, result);
        return ackLoss
          ? Response.json({ error: "ack lost" }, { status: 503 })
          : Response.json(result);
      }
      if (
        request.method === "GET" &&
        /^\/runs\/(apply_http_direct|destroy_http_direct)\/artifacts\/tfstate$/u.test(
          url.pathname,
        )
      ) {
        if (variant === "v2-ack-loss-state-missing")
          return Response.json({ error: "state absent" }, { status: 404 });
        return new Response(stateBytes, {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const stored: LocalOpenTofuStateArtifact[] = [];
  const stateStore = {
    read: async (stateRef: string) =>
      stored.find((artifact) => artifact.stateRef === stateRef),
    commit: async (artifact: LocalOpenTofuStateArtifact) => {
      stored.push(artifact);
      return artifact;
    },
    readRawOutput: async () => undefined,
    commitRawOutput: async <T>(artifact: T): Promise<T> => artifact,
    readProviderLockfile: async (ref: string) => {
      const runId =
        /^local-opentofu:\/\/runs\/(plan_http_apply|plan_http_destroy)\/provider-lockfile$/u.exec(
          ref,
        )?.[1];
      return runId
        ? {
            ref,
            runId,
            digest: lockDigest,
            sizeBytes: lockBytes.byteLength,
            bytes: lockBytes,
          }
        : undefined;
    },
  };

  try {
    const runner = createHttpOpenTofuRunner({
      stateStore,
      archiveStore: {
        write: async () => {},
        read: async () => {
          throw new Error("not used");
        },
      },
      baseUrl: server.url.href,
    });
    const authority = FIXTURE_EXECUTION_EVIDENCE_AUTHORITY;
    const profile = {
      id: "opentofu-default",
      executorId: "opentofu.default",
    };
    const expectedArtifacts = [
      { source: provider, digest: installedDigest, attested: true },
    ];
    const applyJob = {
      applyRun: { id: "apply_http_direct" },
      planRun: {
        id: "plan_http_apply",
        planDigest,
        providerLockDigest: lockDigest,
        providerLockArtifact: {
          kind: "local",
          ref: "local-opentofu://runs/plan_http_apply/provider-lockfile",
          digest: lockDigest,
          sizeBytes: lockBytes.byteLength,
        },
      },
      planArtifact: {
        kind: "runner-local",
        ref: "runner-local://plan_http_apply/tfplan",
        digest: planDigest,
      },
      runnerProfile: profile,
      executionEvidenceAuthority: authority,
      executionEvidenceCommit: {
        stateVersionId: "state_http_apply",
        outputId: "output_http_apply",
      },
      stateScope: {
        workspaceId: "workspace_http",
        subject: { kind: "resource", id: "resource_http_apply" },
        environment: "production",
        generation: 1,
        stateRef: "state://http/direct-apply",
      },
      rawOutputRef: "output://http/direct-apply",
    } as Parameters<typeof runner.apply>[0];
    if (variant.endsWith("mismatch") || variant.endsWith("missing")) {
      await expect(runner.apply(applyJob)).rejects.toMatchObject({
        name: "OpenTofuRunnerExecutionError",
        reason: "runner_mutation_indeterminate",
      });
      expect(stored).toHaveLength(0);
      expect(requests.filter((value) => value === "POST /runs/apply_http_direct")).toHaveLength(1);
      return;
    }
    const apply = await runner.apply(applyJob);
    expect(apply.executionEvidence?.authority.providerArtifacts).toEqual(
      expectedArtifacts,
    );
    expect(apply.outputs?.public_url?.value).toBe("https://direct.example");

    const destroy = await runner.destroy({
      applyRun: { id: "destroy_http_direct" },
      planRun: {
        id: "plan_http_destroy",
        planDigest,
        providerLockDigest: lockDigest,
        providerLockArtifact: {
          kind: "local",
          ref: "local-opentofu://runs/plan_http_destroy/provider-lockfile",
          digest: lockDigest,
          sizeBytes: lockBytes.byteLength,
        },
      },
      planArtifact: {
        kind: "runner-local",
        ref: "runner-local://plan_http_destroy/tfplan",
        digest: planDigest,
      },
      runnerProfile: profile,
      executionEvidenceAuthority: authority,
      executionEvidenceCommit: {
        destroyed: true,
        stateVersionId: "state_http_destroy",
      },
      stateScope: {
        workspaceId: "workspace_http",
        subject: { kind: "resource", id: "resource_http_destroy" },
        environment: "production",
        generation: 1,
        stateRef: "state://http/direct-destroy",
      },
    } as Parameters<typeof runner.destroy>[0]);
    expect(destroy.executionEvidence?.authority.providerArtifacts).toEqual(
      expectedArtifacts,
    );
    expect(stored).toHaveLength(2);
    expect(requests).toEqual([
      "GET /runs/apply_http_direct/completion",
      "GET /runs/plan_http_apply/artifacts/tfplan",
      "POST /runs/apply_http_direct/plan-state-metadata",
      `PUT /runs/apply_http_direct/mutation-${custodyVersion === "v2" ? "preparation" : "reservation"}`,
      "PUT /runs/apply_http_direct/artifacts/tfplan",
      "PUT /runs/apply_http_direct/provider-lockfile/restore",
      "POST /runs/apply_http_direct",
      ...(ackLoss ? ["GET /runs/apply_http_direct/completion"] : []),
      "GET /runs/apply_http_direct/artifacts/tfstate",
      "GET /runs/destroy_http_direct/completion",
      "GET /runs/plan_http_destroy/artifacts/tfplan",
      "POST /runs/destroy_http_direct/plan-state-metadata",
      `PUT /runs/destroy_http_direct/mutation-${custodyVersion === "v2" ? "preparation" : "reservation"}`,
      "PUT /runs/destroy_http_direct/artifacts/tfplan",
      "PUT /runs/destroy_http_direct/provider-lockfile/restore",
      "POST /runs/destroy_http_direct",
      ...(ackLoss ? ["GET /runs/destroy_http_direct/completion"] : []),
      "GET /runs/destroy_http_direct/artifacts/tfstate",
    ]);
    expect(restoreMarkers).toEqual([lockDigest, lockDigest]);
  } finally {
    server.stop(true);
  }
});

test("local reviewed Plan refuses a foreign lock ref before provider dispatch", async () => {
  const planBytes = new TextEncoder().encode("reviewed plan");
  const planDigest = await sha256(planBytes);
  const lockDigest = await sha256(new TextEncoder().encode("# lock\n"));
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/healthz")
        return Response.json({ ok: true, mutationCustodyMode: "local-http" });
      requests.push(`${request.method} ${path}`);
      if (request.method === "POST" && path === "/runs/apply_foreign/plan-state-metadata") {
        return Response.json({ lineage: "", serial: 0 });
      }
      if (
        request.method === "PUT" &&
        path === "/runs/apply_foreign/mutation-reservation"
      ) {
        return Response.json(
          { token: "00000000-0000-4000-8000-000000000000" },
          { status: 201 },
        );
      }
      if (
        request.method === "GET" &&
        path === "/runs/plan_owned/artifacts/tfplan"
      ) {
        return new Response(planBytes);
      }
      if (
        request.method === "PUT" &&
        path === "/runs/apply_foreign/artifacts/tfplan"
      ) {
        return Response.json({ ok: true });
      }
      if (
        request.method === "GET" &&
        path === "/runs/apply_foreign/completion"
      ) {
        return Response.json({ status: "absent" }, { status: 404 });
      }
      return Response.json({ error: "must not dispatch" }, { status: 500 });
    },
  });
  try {
    const runner = createHttpOpenTofuRunner({
      stateStore: {
        read: async () => undefined,
        commit: async <T>(artifact: T): Promise<T> => artifact,
        readRawOutput: async () => undefined,
        commitRawOutput: async <T>(artifact: T): Promise<T> => artifact,
        readProviderLockfile: async () => {
          throw new Error("foreign ref must be rejected before store access");
        },
      },
      archiveStore: {
        write: async () => {},
        read: async () => {
          throw new Error("not used");
        },
      },
      baseUrl: server.url.href,
    });
    await expect(
      runner.apply({
        applyRun: { id: "apply_foreign" },
        planRun: {
          id: "plan_owned",
          planDigest,
          providerLockDigest: lockDigest,
          providerLockArtifact: {
            kind: "local",
            ref: "local-opentofu://runs/other-plan/provider-lockfile",
            digest: lockDigest,
            sizeBytes: 7,
          },
        },
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan_owned/tfplan",
          digest: planDigest,
        },
        runnerProfile: {
          id: "opentofu-default",
          executorId: "opentofu.default",
        },
        stateScope: {
          workspaceId: "workspace_foreign",
          subject: { kind: "resource", id: "resource_foreign" },
          environment: "production",
          generation: 1,
          stateRef: "state://foreign",
        },
      } as Parameters<typeof runner.apply>[0]),
    ).rejects.toThrow("local reviewed Plan provider lock authority is invalid");
    expect(requests).toEqual([
      "GET /runs/apply_foreign/completion",
      "GET /runs/plan_owned/artifacts/tfplan",
      "POST /runs/apply_foreign/plan-state-metadata",
      "PUT /runs/apply_foreign/mutation-reservation",
      "PUT /runs/apply_foreign/artifacts/tfplan",
    ]);
  } finally {
    server.stop(true);
  }
});

test("local reviewed Plan refuses a foreign lock ref before provider dispatch", async () => {
  const planBytes = new TextEncoder().encode("reviewed plan");
  const planDigest = await sha256(planBytes);
  const lockDigest = await sha256(new TextEncoder().encode("# lock\n"));
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/healthz")
        return Response.json({ ok: true, mutationCustodyMode: "local-http" });
      requests.push(`${request.method} ${path}`);
      if (request.method === "POST" && path === "/runs/apply_foreign/plan-state-metadata") {
        return Response.json({ lineage: "", serial: 0 });
      }
      if (
        request.method === "PUT" &&
        path === "/runs/apply_foreign/mutation-reservation"
      ) {
        return Response.json(
          { token: "00000000-0000-4000-8000-000000000000" },
          { status: 201 },
        );
      }
      if (
        request.method === "GET" &&
        path === "/runs/plan_owned/artifacts/tfplan"
      ) {
        return new Response(planBytes);
      }
      if (
        request.method === "PUT" &&
        path === "/runs/apply_foreign/artifacts/tfplan"
      ) {
        return Response.json({ ok: true });
      }
      if (
        request.method === "GET" &&
        path === "/runs/apply_foreign/completion"
      ) {
        return Response.json({ status: "absent" }, { status: 404 });
      }
      return Response.json({ error: "must not dispatch" }, { status: 500 });
    },
  });
  try {
    const runner = createHttpOpenTofuRunner({
      stateStore: {
        read: async () => undefined,
        commit: async <T>(artifact: T): Promise<T> => artifact,
        readRawOutput: async () => undefined,
        commitRawOutput: async <T>(artifact: T): Promise<T> => artifact,
        readProviderLockfile: async () => {
          throw new Error("foreign ref must be rejected before store access");
        },
      },
      archiveStore: {
        write: async () => {},
        read: async () => {
          throw new Error("not used");
        },
      },
      baseUrl: server.url.href,
    });
    await expect(
      runner.apply({
        applyRun: { id: "apply_foreign" },
        planRun: {
          id: "plan_owned",
          planDigest,
          providerLockDigest: lockDigest,
          providerLockArtifact: {
            kind: "local",
            ref: "local-opentofu://runs/other-plan/provider-lockfile",
            digest: lockDigest,
            sizeBytes: 7,
          },
        },
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan_owned/tfplan",
          digest: planDigest,
        },
        runnerProfile: {
          id: "opentofu-default",
          executorId: "opentofu.default",
        },
        stateScope: {
          workspaceId: "workspace_foreign",
          subject: { kind: "resource", id: "resource_foreign" },
          environment: "production",
          generation: 1,
          stateRef: "state://foreign",
        },
      } as Parameters<typeof runner.apply>[0]),
    ).rejects.toThrow("local reviewed Plan provider lock authority is invalid");
    expect(requests).toEqual([
      "GET /runs/apply_foreign/completion",
      "GET /runs/plan_owned/artifacts/tfplan",
      "POST /runs/apply_foreign/plan-state-metadata",
      "PUT /runs/apply_foreign/mutation-reservation",
      "PUT /runs/apply_foreign/artifacts/tfplan",
    ]);
  } finally {
    server.stop(true);
  }
});

test("local HTTP custody recovers a typed partial failure after proxy HTML 500 without a second provider POST", async () => {
  const runId = `apply_custody_${crypto.randomUUID().replace(/-/g, "")}`;
  const planId = `plan_custody_${crypto.randomUUID().replace(/-/g, "")}`;
  const runRoot = Bun.env.TAKOSUMI_OPENTOFU_RUN_ROOT ?? "/tmp/takosumi-runs";
  const applyRoot = join(runRoot, runId);
  const planRoot = join(runRoot, planId);
  const fakeBin = join(tmpdir(), `takosumi-custody-bin-${crypto.randomUUID()}`);
  const callsPath = join(fakeBin, "provider-calls");
  const priorPath = Bun.env.PATH;
  const planBytes = new TextEncoder().encode("reviewed plan for custody");
  const planDigest = await sha256(planBytes);
  const archiveBytes = new TextEncoder().encode("source archive fixture");
  const archiveDigest = await sha256(archiveBytes);
  const partialState = '{"version":4,"serial":1,"resources":[]}\n';
  let posts = 0;
  let sourceRestores = 0;
  let planRestores = 0;
  let firstReadbackLost = false;
  let tamperStateReadback = false;
  let initialCompletionChecks = 0;
  let releaseInitialChecks: (() => void) | undefined;
  const initialChecks = new Promise<void>((resolve) => {
    releaseInitialChecks = resolve;
  });
  let stored: LocalOpenTofuStateArtifact | undefined;
  const stateStore = {
    read: async (ref: string) =>
      stored?.stateRef === ref ? stored : undefined,
    commit: async (artifact: LocalOpenTofuStateArtifact) => {
      stored = artifact;
      return artifact;
    },
    readRawOutput: async () => undefined,
    commitRawOutput: async () => {
      throw new Error("failed apply cannot publish output");
    },
  };
  await mkdir(join(applyRoot, "source"), { recursive: true });
  await mkdir(planRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(applyRoot, "source", "main.tf"), "terraform {}\n");
  await writeFile(join(planRoot, "tfplan"), planBytes);
  await writeFile(
    join(fakeBin, "tofu"),
    `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  init) exit 0 ;;
  apply)
    echo called >> '${callsPath}'
    cat > terraform.tfstate <<'JSON'
${partialState.trimEnd()}
JSON
    echo "provider failed after partial state" >&2
    exit 1
    ;;
  *) exit 0 ;;
esac
`,
  );
  await chmod(join(fakeBin, "tofu"), 0o755);
  Bun.env.PATH = `${fakeBin}:${priorPath ?? ""}`;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === `/runs/${runId}/plan-state-metadata`) {
        return Response.json({ lineage: "", serial: 0 });
      }
      if (
        request.method === "PUT" &&
        path === `/runs/${runId}/source-archive/restore`
      ) {
        sourceRestores += 1;
        if (sourceRestores > 1)
          await rm(join(applyRoot, "source", "terraform.tfstate"), {
            force: true,
          });
        return Response.json({ ok: true });
      }
      if (
        request.method === "PUT" &&
        path === `/runs/${runId}/artifacts/tfplan`
      ) {
        planRestores += 1;
      }
      if (
        request.method === "GET" &&
        path === `/runs/${runId}/completion` &&
        posts === 0
      ) {
        const absent = await handleRunnerRequest(request);
        initialCompletionChecks += 1;
        if (initialCompletionChecks === 2) releaseInitialChecks?.();
        await initialChecks;
        return absent;
      }
      if (
        request.method === "GET" &&
        path === `/runs/${runId}/completion` &&
        posts > 0 &&
        !firstReadbackLost
      ) {
        firstReadbackLost = true;
        return Response.json(
          { error: "temporary readback failure" },
          { status: 503 },
        );
      }
      if (
        request.method === "GET" &&
        path === `/runs/${runId}/artifacts/tfstate` &&
        tamperStateReadback
      ) {
        return new Response('{"version":4,"serial":999,"resources":[]}\n');
      }
      if (request.method === "POST" && path === `/runs/${runId}`) {
        posts += 1;
        const completed = await handleRunnerRequest(request);
        expect(completed.status).toBe(500);
        expect(
          ((await completed.json()) as { stateDigest?: string }).stateDigest,
        ).toBe(await sha256(new TextEncoder().encode(partialState)));
        return new Response("<html>upstream timeout</html>", {
          status: 500,
          headers: { "content-type": "text/html" },
        });
      }
      return await handleRunnerRequest(request);
    },
  });
  try {
    const runner = createHttpOpenTofuRunner({
      stateStore,
      archiveStore: { write: async () => {}, read: async () => archiveBytes },
      baseUrl: server.url.href,
    });
    const job = {
      applyRun: { id: runId },
      planRun: {
        id: planId,
        planDigest,
        source: {
          kind: "git",
          url: "https://git.example.com/example/capsule.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
        },
        requiredProviders: [],
      },
      planArtifact: {
        kind: "runner-local",
        ref: `runner-local://${planId}/tfplan`,
        digest: planDigest,
      },
      sourceArchive: {
        ref: "source://custody",
        digest: archiveDigest,
        sizeBytes: archiveBytes.byteLength,
      },
      runnerProfile: {
        id: "opentofu-default",
        executorId: "opentofu.default",
        allowedProviders: [],
      },
      executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
      executionEvidenceCommit: {
        stateVersionId: "state_custody",
        outputId: "output_custody",
      },
      stateScope: {
        workspaceId: "workspace_1",
        subject: { kind: "capsule", id: "capsule_1" },
        environment: "preview",
        generation: 1,
        stateRef: `workspaces/workspace_1/capsules/capsule_1/environments/preview/state-versions/${runId}.tfstate.enc`,
      },
      rawOutputRef: `workspaces/workspace_1/capsules/capsule_1/runs/${runId}/outputs.raw.json.enc`,
    } as Parameters<typeof runner.apply>[0];
    const concurrent = await Promise.allSettled([
      runner.apply(job),
      runner.apply(job),
    ]);
    expect(concurrent.map((outcome) => outcome.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(initialCompletionChecks).toBe(2);
    expect(stored).toBeUndefined();
    expect(posts).toBe(1);
    const changedBeforeAdoption = {
      ...job,
      planRun: {
        ...job.planRun,
        planDigest: `sha256:${"0".repeat(64)}`,
      },
    };
    await expect(runner.apply(changedBeforeAdoption)).rejects.toThrow(
      "local runner mutation completion is indeterminate",
    );
    expect(sourceRestores).toBe(1);
    expect(posts).toBe(1);
    tamperStateReadback = true;
    await expect(runner.apply(job)).rejects.toThrow(
      "local runner completion state digest mismatch",
    );
    expect(posts).toBe(1);
    expect(sourceRestores).toBe(1);
    expect(stored).toBeUndefined();
    tamperStateReadback = false;
    const first = await runner.apply(job);
    expect(first.providerExecutionFailure).toMatchObject({
      kind: "provider_execution_failed",
      statePersistence: "persisted",
    });
    expect(first.stateDigest).toBe(
      await sha256(new TextEncoder().encode(partialState)),
    );
    expect(first.outputs).toBeUndefined();
    expect(stored?.stateBytes).toEqual(new TextEncoder().encode(partialState));
    expect(posts).toBe(1);
    expect(sourceRestores).toBe(1);
    expect(planRestores).toBe(1);
    const changed = {
      ...job,
      planRun: { ...job.planRun, planDigest: `sha256:${"0".repeat(64)}` },
    };
    const mismatch = await handleRunnerRequest(
      new Request(`http://runner/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run@v1",
          action: "apply",
          runId,
          request: changed,
        }),
      }),
    );
    expect(mismatch.status).toBe(409);
    const wrongDigest = await handleRunnerRequest(
      new Request(`http://runner/runs/${runId}/completion`, {
        headers: {
          "x-takosumi-mutation-action": "apply",
          "x-takosumi-mutation-digest": `sha256:${"0".repeat(64)}`,
        },
      }),
    );
    expect(wrongDigest.status).toBe(409);
    const wrongLockMarker = await handleRunnerRequest(
      new Request(`http://runner/runs/${runId}/completion`, {
        headers: {
          "x-takosumi-mutation-action": "apply",
          "x-takosumi-mutation-digest": await mutationRequestDigest(
            runId,
            "apply",
            job,
          ),
          "x-takosumi-provider-lock-restore-digest": `sha256:${"a".repeat(64)}`,
        },
      }),
    );
    expect(wrongLockMarker.status).toBe(409);
    const again = await runner.apply(job);
    expect(again).toEqual(first);
    expect(posts).toBe(1);
    expect((await readFile(callsPath, "utf8")).trim().split("\n")).toHaveLength(
      1,
    );
  } finally {
    server.stop(true);
    if (priorPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = priorPath;
    await rm(applyRoot, { recursive: true, force: true });
    await rm(planRoot, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("local HTTP custody never redispatches an unfinished exact mutation", async () => {
  const runId = `apply_unfinished_${crypto.randomUUID().replace(/-/g, "")}`;
  const request = {
    applyRun: { id: runId },
    planRun: { id: "plan_unfinished" },
  };
  const reservation = await reserveLocalMutation(runId, "apply", request);
  expect(reservation).toBeString();
  const digest = await mutationRequestDigest(runId, "apply", request);
  const readback = await handleRunnerRequest(
    new Request(`http://runner/runs/${runId}/completion`, {
      headers: {
        "x-takosumi-mutation-action": "apply",
        "x-takosumi-mutation-digest": digest,
      },
    }),
  );
  expect(readback.status).toBe(409);
  const replay = await handleRunnerRequest(
    new Request(`http://runner/runs/${runId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "apply",
        runId,
        request,
      }),
    }),
  );
  expect(replay.status).toBe(409);
});

test("a preparing local HTTP mutation can transfer to an exact new attempt without letting the stale owner replace its plan or dispatch", async () => {
  const runId = `apply_preparing_${crypto.randomUUID().replace(/-/g, "")}`;
  const request = { applyRun: { id: runId }, planRun: { id: "plan_exact" } };
  const attemptA = crypto.randomUUID();
  const attemptB = crypto.randomUUID();
  const acquire = (attemptId: string) =>
    handleRunnerRequestV2(
      new Request(`http://runner/runs/${runId}/mutation-preparation`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, action: "apply", request, attemptId }),
      }),
    );
  const first = await acquire(attemptA);
  expect(first.status).toBe(201);
  expect((await first.json()).epoch).toBe(1);

  const transferred = await acquire(attemptB);
  expect(transferred.status).toBe(201);
  expect((await transferred.json()).epoch).toBe(2);

  const planBytes = new TextEncoder().encode("exact reviewed plan");
  const currentPlan = await handleRunnerRequestV2(
    new Request(`http://runner/runs/${runId}/artifacts/tfplan`, {
      method: "PUT",
      headers: {
        "x-takosumi-preparation-attempt": attemptB,
        "x-takosumi-preparation-epoch": "2",
      },
      body: planBytes,
    }),
  );
  expect(currentPlan.status).toBe(200);

  const staleRestore = await handleRunnerRequestV2(
    new Request(`http://runner/runs/${runId}/source-archive/restore`, {
      method: "PUT",
      headers: {
        "x-takosumi-preparation-attempt": attemptA,
        "x-takosumi-preparation-epoch": "1",
      },
      body: new Uint8Array([1, 2, 3]),
    }),
  );
  expect(staleRestore.status).toBe(409);
  const readback = await handleRunnerRequestV2(
    new Request(`http://runner/runs/${runId}/artifacts/tfplan`),
  );
  expect(new Uint8Array(await readback.arrayBuffer())).toEqual(planBytes);

  const stalePost = await handleRunnerRequestV2(
    new Request(`http://runner/runs/${runId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-takosumi-preparation-attempt": attemptA,
        "x-takosumi-preparation-epoch": "1",
      },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1",
        action: "apply",
        runId,
        request,
      }),
    }),
  );
  expect(stalePost.status).toBe(409);
});

test("a superseded v2 attempt cannot reclaim ownership through a late reservation retry", async () => {
  const runId = `apply_old_attempt_${crypto.randomUUID().replace(/-/g, "")}`;
  const request = { applyRun: { id: runId }, planRun: { id: "plan_exact" } };
  const attemptA = crypto.randomUUID();
  const attemptB = crypto.randomUUID();
  const acquire = (attemptId: string) => handleRunnerRequestV2(new Request(
    `http://runner/runs/${runId}/mutation-preparation`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId, action: "apply", request, attemptId }),
    },
  ));
  expect((await acquire(attemptA)).status).toBe(201);
  const transferred = await acquire(attemptB);
  expect(transferred.status).toBe(201);
  expect((await transferred.json()).epoch).toBe(2);
  expect((await acquire(attemptA)).status).toBe(409);
  const currentRetry = await acquire(attemptB);
  expect(currentRetry.status).toBe(201);
  expect((await currentRetry.json()).epoch).toBe(2);
  const stale = await handleRunnerRequestV2(new Request(
    `http://runner/runs/${runId}/artifacts/tfplan`, {
      method: "PUT",
      headers: {
        "x-takosumi-preparation-attempt": attemptA,
        "x-takosumi-preparation-epoch": "1",
      },
      body: new TextEncoder().encode("stale"),
    },
  ));
  expect(stale.status).toBe(409);
});

test.each([
  ["claim", "file"], ["claim", "directory"],
  ["owner-2", "file"], ["owner-2", "directory"],
  ["ready-1", "file"], ["ready-1", "directory"],
] as const)(
  "a v2 %s record with failed %s fsync is not adopted until exact file and parent re-sync",
  async (record, failedStep) => {
    const runId = `apply_sync_${crypto.randomUUID().replace(/-/g, "")}`;
    const request = { applyRun: { id: runId }, planRun: { id: "plan_sync" } };
    const attemptA = crypto.randomUUID();
    const attemptB = crypto.randomUUID();
    const pathMatches = (path: string) => record === "claim"
      ? path.endsWith(".claim.json")
      : path.endsWith(`.claim.json.${record}.json`);
    const failure = () => handleRunnerRequestWithDependencies(new Request(
      `http://runner/runs/${runId}/mutation-preparation`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, action: "apply", request,
          attemptId: record === "owner-2" ? attemptB : attemptA }),
      },
    ), {
      mutationCustodyMode: "local-http", localPreparationV2: true,
      localMutationSyncFault: (step, path) => {
        if (step === failedStep && pathMatches(path))
          throw new Error("injected fsync failure");
      },
    });
    const acquire = (attemptId: string) => handleRunnerRequestV2(new Request(
      `http://runner/runs/${runId}/mutation-preparation`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, action: "apply", request, attemptId }),
      },
    ));
    if (record === "owner-2") expect((await acquire(attemptA)).status).toBe(201);
    expect((await failure()).status).toBe(409);
    expect((await failure()).status).toBe(409);
    const recovered = await acquire(record === "owner-2" ? attemptB : attemptA);
    expect(recovered.status).toBe(201);
    expect((await recovered.json()).epoch).toBe(record === "owner-2" ? 2 : 1);
  },
);

test("a failed v2 dispatch fsync returns indeterminate without provider execution or a second POST", async () => {
  const runId = `apply_dispatch_sync_${crypto.randomUUID().replace(/-/g, "")}`;
  const request = { applyRun: { id: runId }, planRun: { id: "plan_sync" } };
  const attemptId = crypto.randomUUID();
  const acquire = await handleRunnerRequestV2(new Request(`http://runner/runs/${runId}/mutation-preparation`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId, action: "apply", request, attemptId }),
  }));
  expect(acquire.status).toBe(201);
  const postRequest = () => new Request(`http://runner/runs/${runId}`, {
    method: "POST", headers: {
      "content-type": "application/json",
      "x-takosumi-preparation-attempt": attemptId,
      "x-takosumi-preparation-epoch": "1",
    },
    body: JSON.stringify({ kind: "takosumi.opentofu-run@v1", runId, action: "apply", request }),
  });
  const refused = await handleRunnerRequestWithDependencies(postRequest(), {
    mutationCustodyMode: "local-http", localPreparationV2: true,
    localMutationSyncFault: (step, path) => {
      if (step === "directory" && path.endsWith(".dispatched"))
        throw new Error("injected dispatch fsync failure");
    },
  });
  expect(refused.status).toBe(409);
  expect((await refused.json()).errorCode).toBe("runner_mutation_indeterminate");
  expect((await handleRunnerRequestV2(postRequest())).status).toBe(409);
});

test("a local HTTP preparing claim is readable only for the exact request and never masquerades as a completion", async () => {
  const runId = `apply_preparing_read_${crypto.randomUUID().replace(/-/g, "")}`;
  const request = { applyRun: { id: runId }, planRun: { id: "plan_exact" } };
  const attemptId = crypto.randomUUID();
  const first = await handleRunnerRequestV2(new Request(`http://runner/runs/${runId}/mutation-preparation`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId, action: "apply", request, attemptId }),
  }));
  expect(first.status).toBe(201);
  const sameAttempt = await handleRunnerRequestV2(new Request(`http://runner/runs/${runId}/mutation-preparation`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId, action: "apply", request, attemptId }),
  }));
  expect(sameAttempt.status).toBe(201);
  expect((await sameAttempt.json()).epoch).toBe(1);
  const digest = await mutationRequestDigest(runId, "apply", request);
  const preparing = await handleRunnerRequestV2(new Request(`http://runner/runs/${runId}/completion`, {
    headers: {
      "x-takosumi-mutation-action": "apply",
      "x-takosumi-mutation-digest": digest,
    },
  }));
  expect(preparing.status).toBe(202);
  expect(await preparing.json()).toEqual({ status: "preparing" });
  const wrong = await handleRunnerRequestV2(new Request(`http://runner/runs/${runId}/completion`, {
    headers: {
      "x-takosumi-mutation-action": "apply",
      "x-takosumi-mutation-digest": `sha256:${"0".repeat(64)}`,
    },
  }));
  expect(wrong.status).toBe(409);
});

test("the HTTP adapter can reprepare an exact interrupted Destroy without a provider POST", async () => {
  const runId = `destroy_reprepare_${crypto.randomUUID().replace(/-/g, "")}`;
  const planId = `plan_${runId}`;
  const planBytes = new TextEncoder().encode("reviewed destroy plan");
  const planDigest = await sha256(planBytes);
  const epochs: number[] = [];
  const reservationAttempts: string[] = [];
  let reservationAckLost = false;
  let providerPosts = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === `/runs/${planId}/artifacts/tfplan`)
        return new Response(planBytes);
      if (request.method === "POST" && path === `/runs/${runId}/plan-state-metadata`)
        return Response.json({ lineage: "", serial: 0 });
      if (request.method === "PUT" && path === `/runs/${runId}/mutation-preparation`) {
        const envelope = await request.clone().json() as { attemptId: string };
        reservationAttempts.push(envelope.attemptId);
        const response = await handleRunnerRequestV2(request);
        if (response.status === 201) {
          const body = await response.clone().json() as { epoch: number };
          epochs.push(body.epoch);
          if (!reservationAckLost) {
            reservationAckLost = true;
            return Response.json({ error: "ack lost" }, { status: 503 });
          }
        }
        return response;
      }
      if (request.method === "PUT" && path === `/runs/${runId}/artifacts/tfplan`)
        return Response.json({ error: "interrupted before dispatch" }, { status: 503 });
      if (request.method === "POST" && path === `/runs/${runId}`) providerPosts += 1;
      return await handleRunnerRequestV2(request);
    },
  });
  try {
    const runner = createHttpOpenTofuRunner({
      stateStore: {
        read: async () => undefined,
        commit: async <T>(artifact: T): Promise<T> => artifact,
        readRawOutput: async () => undefined,
        commitRawOutput: async <T>(artifact: T): Promise<T> => artifact,
      },
      archiveStore: { write: async () => {}, read: async () => { throw new Error("unused"); } },
      baseUrl: server.url.href,
    });
    const job = {
      applyRun: { id: runId },
      planRun: { id: planId, planDigest },
      planArtifact: { kind: "runner-local", ref: `runner-local://${planId}/tfplan`, digest: planDigest },
      runnerProfile: { id: "opentofu-default", executorId: "opentofu.default" },
      stateScope: {
        workspaceId: "workspace_reprepare",
        subject: { kind: "resource", id: "resource_reprepare" },
        environment: "production", generation: 1, stateRef: `state://reprepare/${runId}`,
      },
    } as Parameters<typeof runner.destroy>[0];
    await expect(runner.destroy(job)).rejects.toThrow("failed to restore plan artifact");
    await expect(runner.destroy(job)).rejects.toThrow("failed to restore plan artifact");
    expect(epochs).toEqual([1, 1, 2]);
    expect(reservationAttempts[0]).toBe(reservationAttempts[1]);
    expect(reservationAttempts[2]).not.toBe(reservationAttempts[1]);
    expect(providerPosts).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("an unfinished v2 preparation cannot transfer to another runner process", async () => {
  const runId = `apply_process_${crypto.randomUUID().replace(/-/g, "")}`;
  const request = { applyRun: { id: runId }, planRun: { id: "plan_process" } };
  const first = await handleRunnerRequestV2(new Request(`http://runner/runs/${runId}/mutation-preparation`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId, action: "apply", request, attemptId: crypto.randomUUID() }),
  }));
  expect(first.status).toBe(201);
  const child = Bun.spawn([
    process.execPath,
    "-e",
    `import { handleRunnerRequestWithDependencies } from "./runner/entrypoint.ts";
     const runId = ${JSON.stringify(runId)};
     const request = ${JSON.stringify(request)};
     const response = await handleRunnerRequestWithDependencies(
       new Request("http://runner/runs/" + runId + "/mutation-preparation", {
         method: "PUT", headers: { "content-type": "application/json" },
         body: JSON.stringify({ runId, action: "apply", request, attemptId: crypto.randomUUID() }),
       }),
       { mutationCustodyMode: "local-http", localPreparationV2: true },
     );
     process.stdout.write(String(response.status));`,
  ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const childStatus = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(childStatus).toBe("409");
});

test("a v2 preparation excludes every same-run workspace writer and unrelated action", async () => {
  const runId = `apply_closure_${crypto.randomUUID().replace(/-/g, "")}`;
  const request = { applyRun: { id: runId }, planRun: { id: "plan_closure" } };
  const attemptA = crypto.randomUUID();
  const attemptB = crypto.randomUUID();
  for (const attemptId of [attemptA, attemptB]) {
    const acquired = await handleRunnerRequestV2(new Request(`http://runner/runs/${runId}/mutation-preparation`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId, action: "apply", request, attemptId }),
    }));
    expect(acquired.status).toBe(201);
  }
  for (const suffix of [
    "source-archive/restore",
    "artifacts/tfstate",
    "artifacts/tfplan",
    "provider-lockfile/restore",
    "deps/producer/restore",
  ]) {
    const stale = await handleRunnerRequestV2(new Request(`http://runner/runs/${runId}/${suffix}`, {
      method: "PUT",
      headers: {
        "x-takosumi-preparation-attempt": attemptA,
        "x-takosumi-preparation-epoch": "1",
      },
      body: new TextEncoder().encode("stale"),
    }));
    expect(stale.status).toBe(409);
  }
  const refresh = await handleRunnerRequestV2(new Request(`http://runner/runs/${runId}/credentials`, {
    method: "PUT", body: "{}", headers: { "content-type": "application/json" },
  }));
  expect(refresh.status).toBe(409);
  for (const action of ["plan", "compatibility_check", "backup", "release"]) {
    const unrelated = await handleRunnerRequestV2(new Request(`http://runner/runs/${runId}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "takosumi.opentofu-run@v1", runId, action, request: {} }),
    }));
    expect(unrelated.status).toBe(409);
  }
  for (const action of ["source_sync", "stable_semver_tag"]) {
    const unrelated = await handleRunnerRequestV2(new Request(`http://runner/runs/${runId}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "takosumi.opentofu-run@v1", runId, action, request: { action } }),
    }));
    expect(unrelated.status).toBe(409);
  }
});

test("a v2 dispatched request never transfers or repeats after its reply is unknown", async () => {
  const runId = `apply_dispatched_${crypto.randomUUID().replace(/-/g, "")}`;
  const request = { applyRun: { id: runId }, planRun: { id: "plan_dispatched" } };
  const attemptId = crypto.randomUUID();
  const acquire = (id: string, body: unknown = request) => handleRunnerRequestV2(
    new Request(`http://runner/runs/${runId}/mutation-preparation`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId, action: "apply", request: body, attemptId: id }),
    }),
  );
  expect((await acquire(attemptId)).status).toBe(201);
  const mismatch = await acquire(crypto.randomUUID(), {
    ...request, planRun: { id: "different_plan" },
  });
  expect(mismatch.status).toBe(409);
  const changedCredentialBytes = await acquire(crypto.randomUUID(), {
    ...request, credentials: { env: { PROVIDER_TOKEN: "new-secret-bytes" } },
  });
  expect(changedCredentialBytes.status).toBe(409);
  const post = () => handleRunnerRequestV2(new Request(`http://runner/runs/${runId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-takosumi-preparation-attempt": attemptId,
      "x-takosumi-preparation-epoch": "1",
    },
    body: JSON.stringify({ kind: "takosumi.opentofu-run@v1", runId, action: "apply", request }),
  }));
  expect((await post()).status).toBe(500); // Incomplete fixture fails after durable dispatch.
  const completion = await handleRunnerRequestV2(new Request(`http://runner/runs/${runId}/completion`, {
    headers: {
      "x-takosumi-mutation-action": "apply",
      "x-takosumi-mutation-digest": await mutationRequestDigest(runId, "apply", request),
    },
  }));
  expect(completion.status).toBe(409);
  expect((await acquire(crypto.randomUUID())).status).toBe(409);
  expect((await post()).status).toBe(409);
});

test.each(["succeeded", "provider_failed"] as const)(
  "a real v2 runner POST %s outcome has at-most-once provider dispatch and exact completion readback",
  async (outcome) => {
    const runId = `apply_v2_post_${crypto.randomUUID().replace(/-/g, "")}`;
    const runRoot = join(RUN_ROOT, runId);
    const fakeBin = await mkdtemp(join(tmpdir(), "takosumi-v2-post-bin-"));
    const previousPath = Bun.env.PATH;
    const planBytes = new TextEncoder().encode("fake-reviewed-plan");
    const planDigest = await sha256(planBytes);
    const marker = join(fakeBin, "provider-posts");
    const attemptId = crypto.randomUUID();
    const request = {
      applyRun: { id: runId },
      planRun: {
        id: runId,
        source: {
          kind: "git", url: "https://git.example.com/capsule.git",
          commit: "0123456789abcdef0123456789abcdef01234567",
        },
        requiredProviders: [],
      },
      planArtifact: { kind: "runner-local", ref: `runner-local://${runId}/tfplan`, digest: planDigest },
      runnerProfile: { allowedProviders: [] },
      generatedRoot: { files: { "main.tf": "module \"child\" { source = \"./module\" }\n" } },
      variables: {},
    };
    try {
      const acquire = await handleRunnerRequestV2(new Request(
        `http://runner/runs/${runId}/mutation-preparation`, {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ runId, action: "apply", request, attemptId }),
        },
      ));
      expect(acquire.status).toBe(201);
      expect((await acquire.json()).epoch).toBe(1);
      await mkdir(join(runRoot, "source"), { recursive: true });
      await writeFile(join(runRoot, "source", "main.tf"), "terraform {}\n");
      const preparationHeaders = {
        "x-takosumi-preparation-attempt": attemptId,
        "x-takosumi-preparation-epoch": "1",
      };
      const plan = await handleRunnerRequestV2(new Request(
        `http://runner/runs/${runId}/artifacts/tfplan`, {
          method: "PUT", headers: preparationHeaders, body: planBytes,
        },
      ));
      expect(plan.status).toBe(200);
      const tofuPath = join(fakeBin, "tofu");
      await writeFile(tofuPath, `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  init) echo init ;;
  apply)
    echo apply >> "${marker}"
    cat > terraform.tfstate <<'JSON'
{"version":4,"serial":1,"lineage":"v2-post","resources":[]}
JSON
    ${outcome === "provider_failed" ? 'echo "provider rejected a resource" >&2; exit 1' : "echo apply"}
    ;;
  output) printf '%s' '{"public_url":{"sensitive":false,"type":"string","value":"https://v2.example"}}' ;;
  *) echo "unexpected tofu command: $*" >&2; exit 2 ;;
esac
`);
      await chmod(tofuPath, 0o755);
      Bun.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
      const post = () => handleRunnerRequestV2(new Request(`http://runner/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...preparationHeaders },
        body: JSON.stringify({ kind: "takosumi.opentofu-run@v1", runId, action: "apply", request }),
      }));
      const response = await post();
      expect(response.status).toBe(outcome === "succeeded" ? 200 : 500);
      const direct = await response.json() as Record<string, unknown>;
      expect(direct.status).toBe(outcome === "succeeded" ? "succeeded" : "failed");
      expect(await readFile(marker, "utf8")).toBe("apply\n");
      const digest = await mutationRequestDigest(runId, "apply", request);
      const completion = await handleRunnerRequestV2(new Request(
        `http://runner/runs/${runId}/completion`, {
          headers: {
            "x-takosumi-mutation-action": "apply",
            "x-takosumi-mutation-digest": digest,
            ...(outcome === "succeeded" ? preparationHeaders : {}),
          },
        },
      ));
      expect(completion.status).toBe(outcome === "succeeded" ? 200 : 500);
      if (outcome === "succeeded") {
        const receipt = await completion.json() as Record<string, unknown>;
        expect(receipt.kind).toBe("takosumi.local-mutation-success-readback@v2");
        const adopted = receipt.result as Record<string, unknown>;
        expect(adopted.status).toBe("succeeded");
        expect(adopted.exitCode).toBe(0);
        expect(adopted.outputs).toEqual({
          public_url: { sensitive: false, type: "string", value: "https://v2.example" },
        });
        expect(adopted.stdout).toBeUndefined();
        expect(receipt.resultDigest).toBe(await sha256(new TextEncoder().encode(JSON.stringify(adopted))));
        expect(receipt.stateDigest).toBe(await sha256(new TextEncoder().encode(
          '{"version":4,"serial":1,"lineage":"v2-post","resources":[]}\n',
        )));
        expect(receipt.outputDigest).toBe(await sha256(new TextEncoder().encode(JSON.stringify(adopted.outputs))));
        const claimName = (await sha256(new TextEncoder().encode(runId))).slice(7);
        const persisted = await readFile(join(RUN_ROOT, ".mutation-custody", `${claimName}.completion.json`), "utf8");
        const metadata = JSON.parse(persisted) as Record<string, unknown>;
        expect(metadata.outcome).toBe("succeeded");
        expect(metadata.resultDigest).toBe(receipt.resultDigest);
        expect(metadata.outputDigest).toBe(receipt.outputDigest);
        expect(persisted).not.toContain("https://v2.example");
        const completionFor = (headers: Record<string, string>) =>
          handleRunnerRequestV2(new Request(`http://runner/runs/${runId}/completion`, {
            headers: {
              "x-takosumi-mutation-action": "apply",
              "x-takosumi-mutation-digest": digest,
              ...headers,
            },
          }));
        expect((await completionFor({})).status).toBe(409);
        expect((await completionFor({
          ...preparationHeaders,
          "x-takosumi-mutation-digest": `sha256:${"f".repeat(64)}`,
        })).status).toBe(409);
        expect((await completionFor({
          ...preparationHeaders,
          "x-takosumi-preparation-attempt": crypto.randomUUID(),
        })).status).toBe(409);
        const statePath = join(await readModuleDir(workspaceForRun(runId)), "terraform.tfstate");
        const originalState = await readFile(statePath);
        await writeFile(statePath, '{"version":4,"serial":999,"resources":[]}\n');
        expect((await completionFor(preparationHeaders)).status).toBe(409);
        await writeFile(statePath, originalState);
        expect((await completionFor(preparationHeaders)).status).toBe(200);
      }
      if (outcome === "provider_failed") {
        const receipt = await completion.json() as Record<string, unknown>;
        expect(receipt.providerExecutionFailure).toEqual({ kind: "provider_execution_failed" });
        expect(receipt.stateDigest).toBe(direct.stateDigest);
      }
      expect((await post()).status).toBe(409);
      expect(await readFile(marker, "utf8")).toBe("apply\n");
    } finally {
      if (previousPath === undefined) delete Bun.env.PATH;
      else Bun.env.PATH = previousPath;
      await rm(runRoot, { recursive: true, force: true });
      await rm(fakeBin, { recursive: true, force: true });
    }
  },
);

test("a torn local preparation owner record fails closed without a workspace write", async () => {
  const runId = `apply_torn_${crypto.randomUUID().replace(/-/g, "")}`;
  const request = { applyRun: { id: runId }, planRun: { id: "plan_torn" } };
  const attemptA = crypto.randomUUID();
  const acquire = (attemptId: string) => handleRunnerRequestV2(new Request(`http://runner/runs/${runId}/mutation-preparation`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId, action: "apply", request, attemptId }),
  }));
  expect((await acquire(attemptA)).status).toBe(201);
  const name = (await sha256(new TextEncoder().encode(runId))).slice(7);
  const claimPath = join(RUN_ROOT, ".mutation-custody", `${name}.claim.json`);
  await writeFile(`${claimPath}.owner-2.json`, "{", { mode: 0o600 });
  expect((await acquire(crypto.randomUUID())).status).toBe(409);
  const stale = await handleRunnerRequestV2(new Request(`http://runner/runs/${runId}/artifacts/tfplan`, {
    method: "PUT",
    headers: {
      "x-takosumi-preparation-attempt": attemptA,
      "x-takosumi-preparation-epoch": "1",
    },
    body: new TextEncoder().encode("must not write"),
  }));
  expect(stale.status).toBe(409);
  const missing = await handleRunnerRequestV2(new Request(`http://runner/runs/${runId}/artifacts/tfplan`));
  expect(missing.status).toBe(404);
});

test.each([
  "source-archive/restore",
  "artifacts/tfstate",
  "artifacts/tfplan",
  "provider-lockfile/restore",
  "deps/producer/restore",
])("local HTTP preparation transfer waits for the whole %s writer", async (suffix) => {
  const runId = `apply_stream_${crypto.randomUUID().replace(/-/g, "")}`;
  const request = { applyRun: { id: runId }, planRun: { id: "plan_stream" } };
  const attemptA = crypto.randomUUID();
  const attemptB = crypto.randomUUID();
  const acquire = async (attemptId: string) =>
    await handleRunnerRequestV2(new Request(`http://runner/runs/${runId}/mutation-preparation`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId, action: "apply", request, attemptId }),
    }));
  expect((await acquire(attemptA)).status).toBe(201);
  let releaseBody!: () => void;
  let bodyEntered!: () => void;
  const entered = new Promise<void>((resolve) => { bodyEntered = resolve; });
  const bodyRelease = new Promise<void>((resolve) => { releaseBody = resolve; });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      bodyEntered();
      await bodyRelease;
      controller.enqueue(new TextEncoder().encode("not an archive"));
      controller.close();
    },
  });
  const writing = handleRunnerRequestV2(new Request(`http://runner/runs/${runId}/${suffix}`, {
    method: "PUT",
    headers: {
      "x-takosumi-preparation-attempt": attemptA,
      "x-takosumi-preparation-epoch": "1",
    },
    body,
  }));
  await entered;
  const transfer = acquire(attemptB);
  const premature = await Promise.race([
    transfer.then(() => "transferred"),
    new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 10)),
  ]);
  expect(premature).toBe("waiting");
  releaseBody();
  await writing;
  const response = await transfer;
  expect(response.status).toBe(201);
  expect((await response.json()).epoch).toBe(2);
  const stale = await handleRunnerRequestV2(new Request(`http://runner/runs/${runId}/${suffix}`, {
    method: "PUT",
    headers: {
      "x-takosumi-preparation-attempt": attemptA,
      "x-takosumi-preparation-epoch": "1",
    },
    body: new TextEncoder().encode("stale"),
  }));
  expect(stale.status).toBe(409);
});

test("HTTP OpenTofu runner durably returns failed apply state without replaying provider execution", async () => {
  const planBytes = new TextEncoder().encode("reviewed plan");
  const planDigest = await sha256(planBytes);
  const partialState = new TextEncoder().encode(
    '{"version":4,"serial":1,"resources":[]}',
  );
  const requests: string[] = [];
  let providerPosts = 0;
  let completionDigest: string | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz")
        return Response.json({ ok: true, mutationCustodyMode: "local-http" });
      requests.push(`${request.method} ${url.pathname}`);
      if (request.method === "POST" && url.pathname === "/runs/apply_partial/plan-state-metadata") {
        return Response.json({ lineage: "", serial: 0 });
      }
      if (
        request.method === "GET" &&
        url.pathname === "/runs/apply_partial/completion"
      ) {
        return completionDigest
          ? Response.json(
              {
                status: "failed",
                exitCode: 1,
                errorCode: "apply_failed",
                providerExecutionFailure: { kind: "provider_execution_failed" },
                stateDigest: await sha256(partialState),
              },
              { status: 500 },
            )
          : Response.json({ status: "absent" }, { status: 404 });
      }
      if (
        request.method === "PUT" &&
        url.pathname === "/runs/apply_partial/mutation-reservation"
      ) {
        return Response.json(
          { token: "00000000-0000-4000-8000-000000000000" },
          { status: 201 },
        );
      }
      if (
        request.method === "GET" &&
        url.pathname === "/runs/plan_partial/artifacts/tfplan"
      ) {
        return new Response(planBytes);
      }
      if (
        request.method === "PUT" &&
        url.pathname === "/runs/apply_partial/artifacts/tfplan"
      ) {
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/runs/apply_partial") {
        const envelope = (await request.json()) as { request: unknown };
        completionDigest = await mutationRequestDigest(
          "apply_partial",
          "apply",
          envelope.request,
        );
        providerPosts += 1;
        return Response.json(
          {
            status: "failed",
            exitCode: 1,
            errorCode: "apply_failed",
            providerExecutionFailure: {
              kind: "provider_execution_failed",
            },
            stderr: "provider rejected a later resource",
          },
          { status: 500 },
        );
      }
      if (
        request.method === "GET" &&
        url.pathname === "/runs/apply_partial/artifacts/tfstate"
      ) {
        return new Response(partialState);
      }
      return new Response("not found", { status: 404 });
    },
  });

  let stored: LocalOpenTofuStateArtifact | undefined;
  const stateStore = {
    read: async (stateRef: string) =>
      stored?.stateRef === stateRef ? stored : undefined,
    commit: async (artifact: LocalOpenTofuStateArtifact) => {
      stored = artifact;
      return artifact;
    },
    readRawOutput: async () => undefined,
    commitRawOutput: async () => {
      throw new Error("failed apply must not persist raw output");
    },
  };

  try {
    const runner = createHttpOpenTofuRunner({
      stateStore,
      archiveStore: {
        write: async () => {},
        read: async () => {
          throw new Error("not used");
        },
      },
      baseUrl: server.url.href,
    });
    const job = {
      applyRun: { id: "apply_partial" },
      planRun: { id: "plan_partial", planDigest },
      planArtifact: {
        kind: "runner-local",
        ref: "runner-local://plan_partial/tfplan",
        digest: planDigest,
      },
      runnerProfile: {
        id: "opentofu-default",
        executorId: "opentofu.default",
      },
      executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
      executionEvidenceCommit: {
        stateVersionId: "state_apply_partial",
        outputId: "output_apply_partial",
      },
      stateScope: {
        workspaceId: "workspace_1",
        subject: { kind: "capsule", id: "capsule_1" },
        environment: "preview",
        generation: 1,
        stateRef:
          "workspaces/workspace_1/capsules/capsule_1/environments/preview/state-versions/00000001.tfstate.enc",
      },
      rawOutputRef:
        "workspaces/workspace_1/capsules/capsule_1/runs/apply_partial/outputs.raw.json.enc",
    } as Parameters<typeof runner.apply>[0];

    const first = await runner.apply(job);
    expect(first.providerExecutionFailure).toEqual({
      kind: "provider_execution_failed",
      statePersistence: "persisted",
      errorCode: "apply_failed",
    });
    expect(first.stateDigest).toBe(await sha256(partialState));
    expect(first.outputs).toBeUndefined();
    expect(first.rawOutputRef).toBeUndefined();
    expect(stored?.stateBytes).toEqual(partialState);

    const replay = await runner.apply(job);
    expect(replay).toEqual(first);
    expect(providerPosts).toBe(1);
    expect(
      requests.filter((entry) => entry === "POST /runs/apply_partial"),
    ).toHaveLength(1);
  } finally {
    server.stop(true);
  }
});

test("HTTP OpenTofu runner durably returns failed destroy state without replaying provider execution", async () => {
  const planBytes = new TextEncoder().encode("reviewed destroy plan");
  const planDigest = await sha256(planBytes);
  const partialState = new TextEncoder().encode(
    '{"version":4,"serial":2,"resources":[]}',
  );
  const requests: string[] = [];
  let providerPosts = 0;
  let completionDigest: string | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz")
        return Response.json({ ok: true, mutationCustodyMode: "local-http" });
      requests.push(`${request.method} ${url.pathname}`);
      if (request.method === "POST" && url.pathname === "/runs/destroy_partial/plan-state-metadata") {
        return Response.json({ lineage: "", serial: 0 });
      }
      if (
        request.method === "GET" &&
        url.pathname === "/runs/destroy_partial/completion"
      ) {
        return completionDigest
          ? Response.json(
              {
                status: "failed",
                exitCode: 1,
                errorCode: "apply_failed",
                providerExecutionFailure: { kind: "provider_execution_failed" },
                stateDigest: await sha256(partialState),
              },
              { status: 500 },
            )
          : Response.json({ status: "absent" }, { status: 404 });
      }
      if (
        request.method === "PUT" &&
        url.pathname === "/runs/destroy_partial/mutation-reservation"
      ) {
        return Response.json(
          { token: "00000000-0000-4000-8000-000000000000" },
          { status: 201 },
        );
      }
      if (
        request.method === "GET" &&
        url.pathname === "/runs/plan_destroy_partial/artifacts/tfplan"
      ) {
        return new Response(planBytes);
      }
      if (
        request.method === "PUT" &&
        url.pathname === "/runs/destroy_partial/artifacts/tfplan"
      ) {
        return Response.json({ ok: true });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/runs/destroy_partial"
      ) {
        const envelope = (await request.json()) as { request: unknown };
        completionDigest = await mutationRequestDigest(
          "destroy_partial",
          "destroy",
          envelope.request,
        );
        providerPosts += 1;
        return Response.json(
          {
            status: "failed",
            exitCode: 1,
            errorCode: "apply_failed",
            providerExecutionFailure: {
              kind: "provider_execution_failed",
            },
            stderr: "provider rejected a later destroy resource",
          },
          { status: 500 },
        );
      }
      if (
        request.method === "GET" &&
        url.pathname === "/runs/destroy_partial/artifacts/tfstate"
      ) {
        return new Response(partialState);
      }
      return new Response("not found", { status: 404 });
    },
  });

  let stored: LocalOpenTofuStateArtifact | undefined;
  const stateStore = {
    read: async (stateRef: string) =>
      stored?.stateRef === stateRef ? stored : undefined,
    commit: async (artifact: LocalOpenTofuStateArtifact) => {
      stored = artifact;
      return artifact;
    },
    readRawOutput: async () => undefined,
    commitRawOutput: async () => {
      throw new Error("failed destroy must not persist raw output");
    },
  };

  try {
    const runner = createHttpOpenTofuRunner({
      stateStore,
      archiveStore: {
        write: async () => {},
        read: async () => {
          throw new Error("not used");
        },
      },
      baseUrl: server.url.href,
    });
    const job = {
      applyRun: { id: "destroy_partial" },
      planRun: { id: "plan_destroy_partial", planDigest },
      planArtifact: {
        kind: "runner-local",
        ref: "runner-local://plan_destroy_partial/tfplan",
        digest: planDigest,
      },
      runnerProfile: {
        id: "opentofu-default",
        executorId: "opentofu.default",
      },
      executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
      executionEvidenceCommit: {
        stateVersionId: "state_destroy_partial",
        destroyed: true,
      },
      stateScope: {
        workspaceId: "workspace_1",
        subject: { kind: "capsule", id: "capsule_1" },
        environment: "preview",
        generation: 1,
        stateRef:
          "workspaces/workspace_1/capsules/capsule_1/environments/preview/state-versions/00000001.tfstate.enc",
      },
    } as Parameters<typeof runner.destroy>[0];

    const first = await runner.destroy(job);
    expect(first.providerExecutionFailure).toEqual({
      kind: "provider_execution_failed",
      statePersistence: "persisted",
      errorCode: "apply_failed",
    });
    expect(first.stateDigest).toBe(await sha256(partialState));
    expect(stored?.action).toBe("destroy");
    expect(stored?.stateBytes).toEqual(partialState);

    const replay = await runner.destroy(job);
    expect(replay).toEqual(first);
    expect(providerPosts).toBe(1);
    expect(
      requests.filter((entry) => entry === "POST /runs/destroy_partial"),
    ).toHaveLength(1);
  } finally {
    server.stop(true);
  }
});

const unusedStateStore = {
  read: async () => undefined,
  commit: async <T>(artifact: T): Promise<T> => artifact,
  readRawOutput: async () => undefined,
  commitRawOutput: async <T>(artifact: T): Promise<T> => artifact,
};

function sourceSnapshot(archiveDigest: string): SourceSnapshot {
  return {
    id: "snap_1",
    origin: "git",
    workspaceId: "workspace_1",
    spaceId: "workspace_1",
    sourceId: "src_1",
    url: "https://git.example.test/apps/sample-app.git",
    ref: "main",
    resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
    path: "deploy/opentofu",
    archiveRef: "sources/snap_1.tar.zst",
    archiveDigest,
    archiveSizeBytes: 7,
    fetchedByRunId: "sync_1",
    fetchedAt: "2026-07-08T00:00:00.000Z",
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
