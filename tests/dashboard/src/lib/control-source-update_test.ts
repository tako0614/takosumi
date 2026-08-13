import { afterEach, describe, expect, test } from "bun:test";
import {
  checkCapsuleCompatibility,
  ControlApiError,
  ControlApiIndeterminateError,
  isImmutableSourceRevision,
  planCapsuleUpdate,
  updateCapsuleSourceRevision,
  waitForLatestSourceSnapshot,
} from "../../../../dashboard/src/lib/control-api.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const OLD_SNAPSHOT = {
  id: "snap_old",
  origin: "git",
  workspaceId: "workspace_1",
  sourceId: "src_1",
  url: "https://example.test/app.git",
  ref: "main",
  resolvedCommit: "a".repeat(40),
  path: ".",
  archiveRef: "sources/snap_old.tar.zst",
  archiveDigest: `sha256:${"a".repeat(64)}`,
  archiveSizeBytes: 1,
  fetchedByRunId: "ssr_old",
  fetchedAt: "2026-07-10T00:00:00.000Z",
} as const;

const NEW_SNAPSHOT = {
  ...OLD_SNAPSHOT,
  id: "snap_new",
  resolvedCommit: "b".repeat(40),
  archiveRef: "sources/snap_new.tar.zst",
  archiveDigest: `sha256:${"b".repeat(64)}`,
  fetchedByRunId: "ssr_new",
  fetchedAt: "2026-07-10T00:01:00.000Z",
} as const;

describe("SourceSnapshot update pinning", () => {
  test("waits for the requested sync instead of accepting an older snapshot", async () => {
    let runReads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/runs/ssr_new") {
        runReads += 1;
        return json({
          run:
            runReads === 1
              ? {
                  id: "ssr_new",
                  type: "source_sync",
                  status: "running",
                  workspaceId: "workspace_1",
                  createdAt: "2026-07-10T00:00:30.000Z",
                }
              : {
                  id: "ssr_new",
                  type: "source_sync",
                  status: "succeeded",
                  workspaceId: "workspace_1",
                  sourceSnapshotId: "snap_new",
                  createdAt: "2026-07-10T00:00:30.000Z",
                },
        });
      }
      if (url === "/api/v1/sources/src_1/snapshots") {
        return json({
          snapshots:
            runReads === 1 ? [OLD_SNAPSHOT] : [OLD_SNAPSHOT, NEW_SNAPSHOT],
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const snapshot = await waitForLatestSourceSnapshot("src_1", {
      runId: "ssr_new",
      timeoutMs: 1_000,
      pollMs: 1,
      maxPollMs: 1,
    });

    expect(snapshot.id).toBe("snap_new");
    expect(runReads).toBe(2);
  });

  test("manual update runs sync, exact compatibility, then plan in order", async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, ...(body === undefined ? {} : { body }) });

      if (url === "/api/v1/capsules/cap_1") {
        return json({
          capsule: {
            id: "cap_1",
            workspaceId: "workspace_1",
            name: "app",
            slug: "app",
            sourceId: "src_1",
            installConfigId: "cfg_1",
            environment: "production",
            currentStateGeneration: 1,
            status: "active",
            autoUpdate: true,
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z",
          },
        });
      }
      if (url === "/api/v1/sources/src_1/sync") {
        return json({ run: { id: "ssr_new" } }, 201);
      }
      if (url === "/api/v1/runs/ssr_new") {
        return json({
          run: {
            id: "ssr_new",
            type: "source_sync",
            status: "succeeded",
            workspaceId: "workspace_1",
            sourceSnapshotId: "snap_new",
            createdAt: "2026-07-10T00:00:30.000Z",
          },
        });
      }
      if (url === "/api/v1/sources/src_1/snapshots") {
        return json({ snapshots: [OLD_SNAPSHOT, NEW_SNAPSHOT] });
      }
      if (url === "/api/v1/sources/src_1/compatibility-check") {
        return json({ report: { id: "caprep_new" } }, 201);
      }
      if (url === "/api/v1/capsules/cap_1/plan") {
        return json({ run: { id: "plan_new" } }, 201);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    expect(await planCapsuleUpdate("cap_1")).toEqual({
      run: { id: "plan_new" },
    });
    expect(calls).toEqual([
      { url: "/api/v1/capsules/cap_1", method: "GET" },
      {
        url: "/api/v1/sources/src_1/sync",
        method: "POST",
        body: { intent: "manual_plan" },
      },
      { url: "/api/v1/runs/ssr_new", method: "GET" },
      { url: "/api/v1/sources/src_1/snapshots", method: "GET" },
      {
        url: "/api/v1/sources/src_1/compatibility-check",
        method: "POST",
        body: { sourceSnapshotId: "snap_new", capsuleId: "cap_1" },
      },
      {
        url: "/api/v1/capsules/cap_1/plan",
        method: "POST",
        body: { compatibilityReportId: "caprep_new" },
      },
    ]);
  });

  test("rejects compatibility checks when source sync omits its Run id", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/v1/sources/src_1/sync") {
        return json({ run: {} }, 201);
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    let error: unknown;
    try {
      await checkCapsuleCompatibility({
        workspaceId: "workspace_1",
        sourceId: "src_1",
        gitUrl: "https://example.test/app.git",
        ref: "main",
        path: ".",
        name: "app",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ControlApiError);
    expect((error as ControlApiError).status).toBe(500);
    expect((error as ControlApiError).code).toBe(
      "invalid_source_sync_response",
    );
    expect(calls).toEqual(["POST /api/v1/sources/src_1/sync"]);
  });
});

const SOURCE_IDENTITY = {
  workspaceId: "workspace_1",
  sourceId: "src_1",
  url: "https://example.test/app.git",
  defaultPath: ".",
} as const;

const SOURCE = {
  id: SOURCE_IDENTITY.sourceId,
  workspaceId: SOURCE_IDENTITY.workspaceId,
  name: "app",
  url: SOURCE_IDENTITY.url,
  defaultRef: "main",
  defaultPath: SOURCE_IDENTITY.defaultPath,
  status: "active",
  autoSync: false,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
} as const;

const CAPSULE = {
  id: "cap_1",
  workspaceId: SOURCE_IDENTITY.workspaceId,
  name: "app",
  slug: "app",
  sourceId: SOURCE_IDENTITY.sourceId,
  installConfigId: "cfg_1",
  environment: "production",
  currentStateGeneration: 1,
  status: "active",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
} as const;

function sourceResponse(source: unknown) {
  return json({ source });
}

function capsuleResponse(capsule: unknown = CAPSULE) {
  return json({ capsule });
}

describe("explicit immutable Workload Source revision", () => {
  const revision = "b".repeat(40);

  test("accepts one PATCH only after exact identity preflight and authoritative readback", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const updated = { ...SOURCE, defaultRef: revision };
    let sourceReads = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, ...(body === undefined ? {} : { body }) });
      if (url === "/api/v1/capsules/cap_1") return capsuleResponse();
      if (url === "/api/v1/sources/src_1" && method === "GET") {
        sourceReads += 1;
        return sourceResponse(sourceReads === 1 ? SOURCE : updated);
      }
      if (url === "/api/v1/sources/src_1" && method === "PATCH") {
        return sourceResponse(updated);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    await expect(
      updateCapsuleSourceRevision("cap_1", SOURCE_IDENTITY, revision),
    ).resolves.toMatchObject({ defaultRef: revision });
    expect(calls).toEqual([
      { url: "/api/v1/capsules/cap_1", method: "GET" },
      { url: "/api/v1/sources/src_1", method: "GET" },
      {
        url: "/api/v1/sources/src_1",
        method: "PATCH",
        body: { defaultRef: revision },
      },
      { url: "/api/v1/sources/src_1", method: "GET" },
    ]);
  });

  test("rejects a successful PATCH whose authoritative readback mismatches", async () => {
    let patches = 0;
    let reads = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/v1/capsules/cap_1") return capsuleResponse();
      if (url !== "/api/v1/sources/src_1") throw new Error(`unexpected ${url}`);
      if (method === "PATCH") {
        patches += 1;
        return sourceResponse({ ...SOURCE, defaultRef: revision });
      }
      reads += 1;
      return sourceResponse(SOURCE);
    }) as typeof fetch;

    await expect(
      updateCapsuleSourceRevision("cap_1", SOURCE_IDENTITY, revision),
    ).rejects.toMatchObject({
      status: 409,
      code: "source_revision_mismatch",
    });
    expect(patches).toBe(1);
    expect(reads).toBe(2);
  });

  test("recovers a lost PATCH acknowledgement when one readback proves commit", async () => {
    let patches = 0;
    let sourceReads = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/v1/capsules/cap_1") return capsuleResponse();
      if (url !== "/api/v1/sources/src_1") throw new Error(`unexpected ${url}`);
      if (method === "PATCH") {
        patches += 1;
        throw new Error("lost acknowledgement");
      }
      sourceReads += 1;
      return sourceResponse(
        sourceReads === 1 ? SOURCE : { ...SOURCE, defaultRef: revision },
      );
    }) as typeof fetch;

    await expect(
      updateCapsuleSourceRevision("cap_1", SOURCE_IDENTITY, revision),
    ).resolves.toMatchObject({ defaultRef: revision });
    expect(patches).toBe(1);
    expect(sourceReads).toBe(2);
  });

  test("returns typed indeterminate after a lost acknowledgement without replaying PATCH", async () => {
    let patches = 0;
    let sourceReads = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/v1/capsules/cap_1") return capsuleResponse();
      if (url !== "/api/v1/sources/src_1") throw new Error(`unexpected ${url}`);
      if (method === "PATCH") {
        patches += 1;
        throw new Error("lost acknowledgement");
      }
      sourceReads += 1;
      return sourceResponse(SOURCE);
    }) as typeof fetch;

    await expect(
      updateCapsuleSourceRevision("cap_1", SOURCE_IDENTITY, revision),
    ).rejects.toMatchObject({
      code: "request_indeterminate",
      operation: "source_patch",
      isIndeterminate: true,
    });
    expect(patches).toBe(1);
    expect(sourceReads).toBe(2);
  });

  test("rejects branches, tags, and empty values before network I/O", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("unexpected network request");
    }) as typeof fetch;
    expect(isImmutableSourceRevision("A".repeat(40))).toBe(true);
    for (const value of ["main", "v1.2.3", ""]) {
      expect(isImmutableSourceRevision(value)).toBe(false);
      await expect(
        updateCapsuleSourceRevision("cap_1", SOURCE_IDENTITY, value),
      ).rejects.toMatchObject({ code: "invalid_source_revision" });
    }
    expect(calls).toBe(0);
  });

  test("rejects a Source belonging to another Capsule or Workspace before PATCH", async () => {
    let patches = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET").toUpperCase() === "PATCH") patches += 1;
      if (String(input) === "/api/v1/capsules/cap_1") {
        return capsuleResponse({ ...CAPSULE, sourceId: "src_other" });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    }) as typeof fetch;
    await expect(
      updateCapsuleSourceRevision("cap_1", SOURCE_IDENTITY, revision),
    ).rejects.toMatchObject({ code: "source_revision_mismatch" });
    expect(patches).toBe(0);
  });

  test("does not start source sync until the exact revision reads back", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url}`);
      if (url === "/api/v1/capsules/cap_1") return capsuleResponse();
      if (url === "/api/v1/sources/src_1") return sourceResponse(SOURCE);
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    await expect(
      planCapsuleUpdate("cap_1", {
        sourceRevision: revision,
        sourceIdentity: SOURCE_IDENTITY,
      }),
    ).rejects.toMatchObject({
      code: "source_revision_mismatch",
    });
    expect(calls).toEqual([
      "GET /api/v1/capsules/cap_1",
      "GET /api/v1/sources/src_1",
    ]);
  });
});
