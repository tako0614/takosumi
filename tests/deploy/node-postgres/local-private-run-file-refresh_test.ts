import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createHttpOpenTofuRunner,
  createLocalOpenTofuRunnerProfile,
} from "../../../deploy/node-postgres/src/local-opentofu-runner.ts";
import {
  PRIVATE_RUN_FILE_REFRESH_CAPABILITY,
  PRIVATE_RUN_FILE_REFRESH_SEQUENCE_HEADER,
  privateRunFileManifestDigest,
  type PrivateRunFileRefreshUpdate,
} from "../../../core/shared/private_run_file_refresh.ts";

test("local adapter stages pre-dispatch rotation and delivers live rotation outside mutation body", async () => {
  const runnerRunId = `plan_refresh_${crypto.randomUUID()}`;
  const owner = { kind: "plan" as const, id: runnerRunId };
  const endpoint = "http://core.internal/internal/private-run-files/v1";
  const files = [{ slot: "journal", endpoint, grant: "opaque-initial" }];
  const manifestDigest = await privateRunFileManifestDigest({ owner, runnerRunId, files });
  const archiveBytes = new TextEncoder().encode("synthetic source archive");
  const archiveDigest = `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}`;
  let archiveRead!: () => void;
  let releaseArchive!: () => void;
  const readingArchive = new Promise<void>((resolve) => { archiveRead = resolve; });
  const archiveReady = new Promise<void>((resolve) => { releaseArchive = resolve; });
  let dispatchStarted!: () => void;
  let finishDispatch!: () => void;
  const started = new Promise<void>((resolve) => { dispatchStarted = resolve; });
  const finish = new Promise<void>((resolve) => { finishDispatch = resolve; });
  let initialSequence: string | null = null;
  let postedGrant: string | undefined;
  let liveGrant: string | undefined;
  let active = false;
  let sequence = 0;
  const planDigest = `sha256:${"a".repeat(64)}`;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/healthz") {
        return Response.json({
          ok: true,
          mutationCustodyMode: "local-http",
          capabilities: [PRIVATE_RUN_FILE_REFRESH_CAPABILITY],
        });
      }
      if (path === `/runs/${runnerRunId}/source-archive/restore` && request.method === "PUT") {
        return Response.json({ ok: true });
      }
      if (path === `/runs/${runnerRunId}` && request.method === "POST") {
        initialSequence = request.headers.get(PRIVATE_RUN_FILE_REFRESH_SEQUENCE_HEADER);
        const body = await request.json() as { request: { privateRunFiles: typeof files } };
        postedGrant = body.request.privateRunFiles[0]?.grant;
        sequence = Number(initialSequence);
        active = true;
        dispatchStarted();
        await finish;
        active = false;
        return Response.json({
          status: "succeeded",
          exitCode: 0,
          planDigest,
          planArtifact: {
            kind: "runner-local",
            ref: `runner-local://${runnerRunId}/tfplan`,
            digest: planDigest,
          },
        });
      }
      if (path === `/runs/${runnerRunId}/private-run-files` && request.method === "GET") {
        return active
          ? Response.json({ owner, runnerRunId, manifestDigest, sequence })
          : Response.json({ error: "inactive" }, { status: 409 });
      }
      if (path === `/runs/${runnerRunId}/private-run-files` && request.method === "PUT") {
        const update = await request.json() as PrivateRunFileRefreshUpdate;
        if (!active || update.manifestDigest !== manifestDigest ||
          update.sequence !== sequence + 1) return Response.json({}, { status: 409 });
        sequence = update.sequence;
        liveGrant = update.files[0]?.grant;
        return Response.json({ ok: true, status: "updated", sequence });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  try {
    const runner = createHttpOpenTofuRunner({
      baseUrl: server.url.href,
      archiveStore: {
        write: async () => {},
        read: async () => {
          archiveRead();
          await archiveReady;
          return archiveBytes;
        },
      },
      stateStore: {
        read: async () => undefined,
        commit: async <T>(artifact: T): Promise<T> => artifact,
        readRawOutput: async () => undefined,
        commitRawOutput: async <T>(artifact: T): Promise<T> => artifact,
      },
    });
    await runner.assertPrivateRunFileRefreshCapability!({ owner, runnerRunId });
    const plan = runner.plan({
      planRun: {
        id: runnerRunId,
        workspaceId: "workspace_local",
        operation: "create",
        status: "running",
      },
      runnerProfile: createLocalOpenTofuRunnerProfile(),
      variables: {},
      sourceArchive: { ref: "source/test", digest: archiveDigest },
      privateRunFiles: files,
    } as Parameters<typeof runner.plan>[0]);
    const update = (nextSequence: number, grant: string): PrivateRunFileRefreshUpdate => ({
      kind: "takosumi.private-run-files.refresh@v1",
      owner,
      runnerRunId,
      manifestDigest,
      sequence: nextSequence,
      files: [{ slot: "journal", endpoint, grant }],
    });
    await readingArchive;
    await runner.refreshPrivateRunFiles!(update(1, "opaque-staged"));
    releaseArchive();
    await started;
    expect(initialSequence).toBe("1");
    expect(postedGrant).toBe("opaque-staged");
    await runner.refreshPrivateRunFiles!(update(2, "opaque-live"));
    expect(liveGrant).toBe("opaque-live");
    finishDispatch();
    await plan;
    await expect(runner.refreshPrivateRunFiles!(update(3, "opaque-late")))
      .rejects.toMatchObject({ reason: "private_run_file_refresh_unavailable" });
  } finally {
    releaseArchive();
    finishDispatch();
    server.stop(true);
  }
});

test("slot-bearing local dispatch refuses an old Runner before source preparation", async () => {
  const paths: string[] = [];
  let archiveReads = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      paths.push(new URL(request.url).pathname);
      return Response.json({ ok: true, mutationCustodyMode: "local-http", capabilities: [] });
    },
  });
  try {
    const runner = createHttpOpenTofuRunner({
      baseUrl: server.url.href,
      archiveStore: {
        write: async () => {},
        read: async () => {
          archiveReads++;
          return new Uint8Array();
        },
      },
      stateStore: {
        read: async () => undefined,
        commit: async <T>(artifact: T): Promise<T> => artifact,
        readRawOutput: async () => undefined,
        commitRawOutput: async <T>(artifact: T): Promise<T> => artifact,
      },
    });
    await expect(runner.plan({
      planRun: { id: "plan_old_runner" },
      runnerProfile: createLocalOpenTofuRunnerProfile(),
      variables: {},
      sourceArchive: { ref: "source/test", digest: `sha256:${"a".repeat(64)}` },
      privateRunFiles: [{
        slot: "journal",
        endpoint: "http://core.internal/internal/private-run-files/v1",
        grant: "opaque-initial",
      }],
    } as Parameters<typeof runner.plan>[0])).rejects.toMatchObject({
      reason: "private_run_file_refresh_unavailable",
    });
    expect(archiveReads).toBe(0);
    expect(paths).toEqual(["/healthz"]);
  } finally {
    server.stop(true);
  }
});
