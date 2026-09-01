/**
 * A correct app must install the same from a pasted Git URL as it does from a
 * catalog listing. The repository's own install manifest is what decides that
 * — not whether a Store row happened to exist.
 */
import { afterEach, expect, test } from "bun:test";

import { checkCapsuleCompatibility } from "../../../../dashboard/src/lib/control-api.ts";

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

function snapshot(manifest: unknown): Record<string, unknown> {
  return {
    id: "snap_1",
    origin: "git",
    workspaceId: "workspace_1",
    sourceId: "src_1",
    url: "https://example.test/app.git",
    ref: "main",
    resolvedCommit: "a".repeat(40),
    path: ".",
    archiveRef: "sources/snap_1.tar.zst",
    archiveDigest: `sha256:${"a".repeat(64)}`,
    archiveSizeBytes: 1,
    fetchedByRunId: "ssr_1",
    fetchedAt: "2026-08-23T00:00:00.000Z",
    ...(manifest === undefined ? {} : { repositoryManifest: manifest }),
  };
}

/** Captures the compatibility-check request body the dashboard actually sends. */
async function compatibilityRequestBody(input: {
  readonly manifest: unknown;
  readonly path?: string;
  readonly installConfigId?: string;
}): Promise<Record<string, unknown>> {
  let sent: Record<string, unknown> | undefined;
  globalThis.fetch = (async (target: RequestInfo | URL, init?: RequestInit) => {
    const url = String(target);
    if (url === "/api/v1/sources/src_1/sync") {
      return json({ run: { id: "ssr_1" } }, 201);
    }
    if (url === "/api/v1/runs/ssr_1") {
      return json({
        run: {
          id: "ssr_1",
          status: "succeeded",
          // waitForLatestSourceSnapshot pins the EXACT snapshot the requested
          // sync produced, so the run must name it.
          sourceSnapshotId: "snap_1",
        },
      });
    }
    if (url.startsWith("/api/v1/sources/src_1/snapshots")) {
      return json({ snapshots: [snapshot(input.manifest)] });
    }
    if (url === "/api/v1/sources/src_1/compatibility-check") {
      sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return json(
        { report: { id: "caprep_1", level: "ready", findings: [] } },
        201,
      );
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  await checkCapsuleCompatibility({
    workspaceId: "workspace_1",
    sourceId: "src_1",
    gitUrl: "https://example.test/app.git",
    ref: "main",
    path: input.path ?? ".",
    name: "app",
    compileInstallUx: "auto",
    ...(input.installConfigId
      ? { installConfigId: input.installConfigId }
      : {}),
  });
  return sent ?? {};
}

test("a repository that ships a manifest gets its install UX compiled from a bare Git URL", async () => {
  const body = await compatibilityRequestBody({
    manifest: { status: "present", digest: `sha256:${"b".repeat(64)}` },
  });
  expect(body.compileInstallUx).toBe(true);
  expect(body.capsuleName).toBe("app");
  // The server resolves both of these from the manifest and rejects the
  // request outright if the client also sends them.
  expect(body.installConfigId).toBeUndefined();
  expect(body.modulePath).toBeUndefined();
});

test("a repository without a manifest keeps the plain path", async () => {
  const body = await compatibilityRequestBody({
    manifest: { status: "absent" },
    installConfigId: "cfg-default-opentofu-capsule",
  });
  // Compiling here would 400 with "repository manifest is absent".
  expect(body.compileInstallUx).toBeUndefined();
  expect(body.installConfigId).toBe("cfg-default-opentofu-capsule");
});

test("an invalid manifest does not silently fall back to compiling it", async () => {
  const body = await compatibilityRequestBody({
    manifest: { status: "invalid", reason: "schema_invalid" },
  });
  expect(body.compileInstallUx).toBeUndefined();
});

test("a snapshot predating manifest observation keeps the plain path", async () => {
  const body = await compatibilityRequestBody({ manifest: undefined });
  expect(body.compileInstallUx).toBeUndefined();
});

test("an explicitly pinned module path overrides the manifest", async () => {
  const body = await compatibilityRequestBody({
    manifest: { status: "present", digest: `sha256:${"c".repeat(64)}` },
    path: "services/api",
  });
  // The user pointed at a specific module on purpose; auto stands down so the
  // choice is honored instead of being replaced by the manifest's default.
  expect(body.compileInstallUx).toBeUndefined();
  expect(body.modulePath).toBe("services/api");
});
