import { afterEach, describe, expect, test } from "bun:test";
import {
  prepareCapsuleSourceSnapshot,
  type Source,
  type SourceSnapshot,
} from "../../../../dashboard/src/lib/control-api.ts";

const originalFetch = globalThis.fetch;
const commit = "a".repeat(40);
const manualCommit = "b".repeat(40);

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function source(defaultRef: string): Source {
  return {
    id: "source_1",
    workspaceId: "workspace_1",
    name: "service",
    url: "https://example.test/service.git",
    defaultRef,
    defaultPath: ".",
    status: "active",
    autoSync: true,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
}

function snapshot(resolvedCommit: string, ref: string): SourceSnapshot {
  return {
    id: "snapshot_1",
    origin: "git",
    workspaceId: "workspace_1",
    sourceId: "source_1",
    url: "https://example.test/service.git",
    ref,
    resolvedCommit,
    path: ".",
    archiveRef: "sources/snapshot_1.tar.zst",
    archiveDigest: `sha256:${"c".repeat(64)}`,
    archiveSizeBytes: 1,
    fetchedByRunId: "sync_run_1",
    fetchedAt: "2026-08-25T00:00:01.000Z",
  };
}

function installFetch(snapshotCommit: string, snapshotRef: string) {
  const calls: Array<{
    readonly url: string;
    readonly method: string;
    readonly body?: unknown;
  }> = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, ...(body === undefined ? {} : { body }) });

    if (url === "/api/v1/workspaces/workspace_1/source-ref-resolutions/stable-semver") {
      return json({ tag: "v1.2.3", commit });
    }
    if (url.startsWith("/api/v1/sources?") && method === "GET") {
      return json({ sources: [] });
    }
    if (url === "/api/v1/sources" && method === "POST") {
      const defaultRef =
        typeof body?.defaultRef === "string" ? body.defaultRef : "HEAD";
      return json({ source: source(defaultRef), hookSecret: "hook_secret" }, 201);
    }
    if (url === "/api/v1/sources/source_1/sync" && method === "POST") {
      return json({ run: { id: "sync_run_1" } }, 201);
    }
    if (url === "/api/v1/runs/sync_run_1" && method === "GET") {
      return json({
        run: {
          id: "sync_run_1",
          type: "source_sync",
          status: "succeeded",
          workspaceId: "workspace_1",
          sourceSnapshotId: "snapshot_1",
          ref: snapshotRef,
          createdAt: "2026-08-25T00:00:00.500Z",
        },
      });
    }
    if (url === "/api/v1/sources/source_1/snapshots" && method === "GET") {
      return json({ snapshots: [snapshot(snapshotCommit, snapshotRef)] });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  }) as typeof fetch;
  return calls;
}

describe("Capsule SourceSnapshot ref selection", () => {
  test("TCS absent refs resolve and create the Source at the immutable commit", async () => {
    const calls = installFetch(commit, commit);

    await expect(
      prepareCapsuleSourceSnapshot({
        workspaceId: "workspace_1",
        gitUrl: "https://example.test/service.git",
        ref: "",
        name: "service",
        resolveAbsentRefToStableSemver: true,
      }),
    ).resolves.toMatchObject({ snapshot: { resolvedCommit: commit } });

    expect(calls.map((call) => call.url)).toEqual([
      "/api/v1/workspaces/workspace_1/source-ref-resolutions/stable-semver",
      "/api/v1/sources?workspaceId=workspace_1&limit=100",
      "/api/v1/sources",
      "/api/v1/sources/source_1/sync",
      "/api/v1/runs/sync_run_1",
      "/api/v1/sources/source_1/snapshots",
    ]);
    expect(calls[0]?.body).toEqual({
      url: "https://example.test/service.git",
    });
    expect(calls[2]?.body).toMatchObject({ defaultRef: commit });
    expect(calls[3]?.body).toEqual({ expectedRef: commit });
  });

  test("manual Git with an absent ref keeps HEAD semantics", async () => {
    const calls = installFetch(manualCommit, "HEAD");

    await expect(
      prepareCapsuleSourceSnapshot({
        workspaceId: "workspace_1",
        gitUrl: "https://example.test/service.git",
        ref: "",
        name: "service",
      }),
    ).resolves.toMatchObject({ snapshot: { resolvedCommit: manualCommit } });

    expect(calls.some((call) => call.url.includes("stable-semver"))).toBe(
      false,
    );
    expect(calls[1]?.body).not.toHaveProperty("defaultRef");
    expect(calls[2]?.body).toEqual({});
  });

  test("explicit refs stay exact even when stable-tag resolution is enabled", async () => {
    const calls = installFetch(manualCommit, "release-1");

    await expect(
      prepareCapsuleSourceSnapshot({
        workspaceId: "workspace_1",
        gitUrl: "https://example.test/service.git",
        ref: "release-1",
        name: "service",
        resolveAbsentRefToStableSemver: true,
      }),
    ).resolves.toMatchObject({ snapshot: { ref: "release-1" } });

    expect(calls.some((call) => call.url.includes("stable-semver"))).toBe(
      false,
    );
    expect(calls[1]?.body).toMatchObject({ defaultRef: "release-1" });
    expect(calls[2]?.body).toEqual({});
  });

  test("TCS fails closed when the synced snapshot is not the resolved commit", async () => {
    installFetch(manualCommit, manualCommit);

    await expect(
      prepareCapsuleSourceSnapshot({
        workspaceId: "workspace_1",
        gitUrl: "https://example.test/service.git",
        ref: "",
        name: "service",
        resolveAbsentRefToStableSemver: true,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "source_revision_mismatch",
    });
  });
});
