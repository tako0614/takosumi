import { expect, test } from "bun:test";

import type { SourceSnapshot } from "../../../contract/sources.ts";
import { createHttpOpenTofuRunner } from "../../../deploy/node-postgres/src/local-opentofu-runner.ts";

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
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const runner = createHttpOpenTofuRunner({
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
    });
    expect(requests).toEqual(["POST /runs/sync_reuse"]);
    expect(writes).toHaveLength(0);
  } finally {
    server.stop(true);
  }
});

function sourceSnapshot(archiveDigest: string): SourceSnapshot {
  return {
    id: "snap_1",
    origin: "git",
    workspaceId: "workspace_1",
    spaceId: "workspace_1",
    sourceId: "src_1",
    url: "https://github.com/tako0614/takos.git",
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
