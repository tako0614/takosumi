import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRunnerRequestWithDependencies } from "../../../runner/entrypoint.ts";
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
  handleRunnerRequestWithDependencies(request, { mutationCustodyMode: "local-http" });

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

test("HTTP OpenTofu runner carries direct provider evidence through apply and destroy commits", async () => {
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
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz")
        return Response.json({ ok: true, mutationCustodyMode: "local-http" });
      requests.push(`${request.method} ${url.pathname}`);
      if (
        request.method === "PUT" &&
        /^\/runs\/(apply_http_direct|destroy_http_direct)\/mutation-reservation$/u.test(
          url.pathname,
        )
      ) {
        return Response.json(
          { token: "00000000-0000-4000-8000-000000000000" },
          { status: 201 },
        );
      }
      if (
        request.method === "GET" &&
        /^\/runs\/(apply_http_direct|destroy_http_direct)\/completion$/u.test(
          url.pathname,
        )
      ) {
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
        return Response.json({ ok: true });
      }
      if (
        request.method === "PUT" &&
        /^\/runs\/(apply_http_direct|destroy_http_direct)\/provider-lockfile\/restore$/u.test(
          url.pathname,
        )
      ) {
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(lockBytes);
        return Response.json({
          digest: lockDigest,
          sizeBytes: lockBytes.byteLength,
        });
      }
      const runMatch =
        /^\/runs\/(apply_http_direct|destroy_http_direct)$/u.exec(url.pathname);
      if (request.method === "POST" && runMatch) {
        restoreMarkers.push(
          request.headers.get("x-takosumi-provider-lock-restore-digest"),
        );
        return Response.json({
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
        });
      }
      if (
        request.method === "GET" &&
        /^\/runs\/(apply_http_direct|destroy_http_direct)\/artifacts\/tfstate$/u.test(
          url.pathname,
        )
      ) {
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
    const apply = await runner.apply({
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
    } as Parameters<typeof runner.apply>[0]);
    expect(apply.executionEvidence?.authority.providerArtifacts).toEqual(
      expectedArtifacts,
    );

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
      "PUT /runs/apply_http_direct/mutation-reservation",
      "GET /runs/plan_http_apply/artifacts/tfplan",
      "PUT /runs/apply_http_direct/artifacts/tfplan",
      "PUT /runs/apply_http_direct/provider-lockfile/restore",
      "POST /runs/apply_http_direct",
      "GET /runs/apply_http_direct/artifacts/tfstate",
      "GET /runs/destroy_http_direct/completion",
      "PUT /runs/destroy_http_direct/mutation-reservation",
      "GET /runs/plan_http_destroy/artifacts/tfplan",
      "PUT /runs/destroy_http_direct/artifacts/tfplan",
      "PUT /runs/destroy_http_direct/provider-lockfile/restore",
      "POST /runs/destroy_http_direct",
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
      "PUT /runs/apply_foreign/mutation-reservation",
      "GET /runs/plan_owned/artifacts/tfplan",
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
      "PUT /runs/apply_foreign/mutation-reservation",
      "GET /runs/plan_owned/artifacts/tfplan",
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
