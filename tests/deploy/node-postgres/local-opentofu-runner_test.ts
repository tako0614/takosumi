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
    archiveObjectKey: "sources/snap_1.tar.zst",
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
