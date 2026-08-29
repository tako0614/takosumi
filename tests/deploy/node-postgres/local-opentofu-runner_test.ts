import { expect, test } from "bun:test";

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
      runner.restore(
        job,
        entry.control as OpenTofuRestoreExecutionControl,
      ),
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

test("HTTP OpenTofu runner durably returns failed apply state without replaying provider execution", async () => {
  const planBytes = new TextEncoder().encode("reviewed plan");
  const planDigest = await sha256(planBytes);
  const partialState = new TextEncoder().encode(
    '{"version":4,"serial":1,"resources":[]}',
  );
  const requests: string[] = [];
  let providerPosts = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
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
      if (
        request.method === "POST" &&
        url.pathname === "/runs/apply_partial"
      ) {
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
      planRun: { id: "plan_partial" },
      planArtifact: {
        kind: "runner-local",
        ref: "runner-local://plan_partial/tfplan",
        digest: planDigest,
      },
      runnerProfile: {},
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
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
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
      planRun: { id: "plan_destroy_partial" },
      planArtifact: {
        kind: "runner-local",
        ref: "runner-local://plan_destroy_partial/tfplan",
        digest: planDigest,
      },
      runnerProfile: {},
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
