import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createHttpOpenTofuRunner,
  createLocalOpenTofuRunnerProfile,
  type LocalOpenTofuStateArtifact,
} from "../../deploy/node-postgres/src/local-opentofu-runner.ts";
import { digestBytes } from "../../runner/lib/util.ts";
import {
  acquireRunRootOwnership,
  adoptRunRootOwnershipFromStdin,
  type RunRootOwnership,
} from "../../runner/lib/run_root_ownership.ts";
import { PreparationV2ChildSupervisor } from "../../runner/lib/preparation_v2_child_supervisor.ts";
import { startRunnerHttpServer } from "../../runner/entrypoint.ts";

const mode = Bun.argv[2];

if (import.meta.main && mode === "--pre-dispatch-resume-supervisor") {
  await runSupervisorFixture(Bun.argv[3] ?? "", Bun.argv[4] ?? "");
} else if (import.meta.main && mode === "--pre-dispatch-resume-http-child") {
  await runHttpChildFixture(Bun.argv[3] ?? "", Bun.argv[4] ?? "");
}

if (
  mode !== "--pre-dispatch-resume-supervisor" &&
  mode !== "--pre-dispatch-resume-http-child"
)
  test.skipIf(
    process.platform !== "linux" ||
      (process.arch !== "x64" && process.arch !== "arm64"),
  )(
    "local v2 adapter resumes a pre-dispatch interruption on the same serving Runner",
    async () => {
      const fixtureRoot = await mkdtemp(
        join(tmpdir(), "takosumi-pre-dispatch-resume-"),
      );
      await chmod(fixtureRoot, 0o700);
      const runRoot = join(fixtureRoot, "run-root");
      const fakeBin = join(fixtureRoot, "fake-bin");
      const sourceDir = join(fixtureRoot, "source");
      const archivePath = join(fixtureRoot, "source.tar.zst");
      const portFile = join(fixtureRoot, "server-port");
      const applyCalls = join(fixtureRoot, "apply-calls");
      await mkdir(runRoot, { mode: 0o700 });
      await mkdir(fakeBin, { mode: 0o700 });
      await mkdir(sourceDir, { mode: 0o700 });
      await writeFile(join(sourceDir, "main.tf"), "terraform {}\n");
      await writeFile(join(fakeBin, "tofu"), fakeTofu(applyCalls), {
        mode: 0o700,
      });
      const tar = spawnSync(
        "tar",
        ["--zstd", "-cf", archivePath, "-C", sourceDir, "."],
        {
          encoding: "utf8",
        },
      );
      if (tar.status !== 0)
        throw new Error(`source archive fixture failed: ${tar.stderr}`);
      const archiveBytes = new Uint8Array(await readFile(archivePath));
      const archiveDigest = await digestBytes(archiveBytes);

      const runId = `resume_${crypto.randomUUID().replaceAll("-", "")}`;
      const planRunId = `${runId}_plan`;
      const planBytes = savedPlanFixture();
      const planDigest = await digestBytes(planBytes);
      const env = {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        HOME: fixtureRoot,
        TMPDIR: fixtureRoot,
        PORT: "0",
        TAKOSUMI_OPENTOFU_RUN_ROOT: runRoot,
        TAKOSUMI_RUNNER_MUTATION_CUSTODY_MODE: "local-http",
      };
      const supervisor = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          import.meta.path,
          "--pre-dispatch-resume-supervisor",
          runRoot,
          portFile,
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "ignore", env },
      );
      const lines = lineReader(supervisor.stdout);
      let supervisorClosed = false;
      let proxy: ReturnType<typeof Bun.serve> | undefined;
      try {
        const ready = await lines.next();
        expect(ready).toMatch(/^ready:\d+$/u);
        const base = `http://127.0.0.1:${ready.slice("ready:".length)}`;
        const health = await fetch(`${base}/healthz`);
        expect(health.status).toBe(200);
        expect(await health.json()).toMatchObject({
          mutationCustodyMode: "local-http",
          capabilities: expect.arrayContaining([
            "takosumi.local-mutation-preparation@v2",
          ]),
        });

        const planUpload = await fetch(
          `${base}/runs/${planRunId}/artifacts/tfplan`,
          {
            method: "PUT",
            headers: { "content-type": "application/vnd.opentofu.plan" },
            body: planBytes.buffer as ArrayBuffer,
          },
        );
        expect(planUpload.ok).toBe(true);

        const attempts: string[] = [];
        const epochs: number[] = [];
        const completionReads: { status: number; body: unknown }[] = [];
        let planMetadataReads = 0;
        let planMetadataStatus: number | undefined;
        let firstAttemptPlanWriteInterrupted = false;
        let staleAttemptWriteStatus: number | undefined;
        let dispatchRequest: Request | undefined;
        let applyPostCount = 0;
        proxy = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const url = new URL(request.url);
            const path = url.pathname;
            if (
              request.method === "POST" &&
              path === `/runs/${runId}/plan-state-metadata`
            ) {
              planMetadataReads += 1;
            }
            if (
              request.method === "PUT" &&
              path === `/runs/${runId}/mutation-preparation`
            ) {
              const preparation = (await request.clone().json()) as {
                attemptId?: string;
              };
              if (preparation.attemptId) attempts.push(preparation.attemptId);
            }
            if (
              request.method === "GET" &&
              path === `/runs/${runId}/completion`
            ) {
              const response = await fetch(
                new Request(new URL(path, base), request),
              );
              completionReads.push({
                status: response.status,
                body: await response.clone().json(),
              });
              return response;
            }
            if (
              request.method === "PUT" &&
              path === `/runs/${runId}/artifacts/tfplan`
            ) {
              const attemptId = request.headers.get(
                "x-takosumi-preparation-attempt",
              );
              const epoch = Number(
                request.headers.get("x-takosumi-preparation-epoch"),
              );
              if (attemptId && !epochs.includes(epoch)) epochs.push(epoch);
              if (
                attemptId === attempts[0] &&
                !firstAttemptPlanWriteInterrupted
              ) {
                firstAttemptPlanWriteInterrupted = true;
                return Response.json(
                  { errorCode: "injected_pre_dispatch_transport_interruption" },
                  { status: 503 },
                );
              }
              if (attemptId === attempts[1] && attempts[0]) {
                const stale = await fetch(
                  `${base}/runs/${runId}/artifacts/tfstate`,
                  {
                    method: "PUT",
                    headers: {
                      "content-type": "application/json",
                      "x-takosumi-preparation-attempt": attempts[0],
                      "x-takosumi-preparation-epoch": "1",
                    },
                    body: '{"stale":true}',
                  },
                );
                staleAttemptWriteStatus = stale.status;
              }
            }
            if (request.method === "POST" && path === `/runs/${runId}`) {
              applyPostCount += 1;
              dispatchRequest = request.clone();
            }
            const upstream = await fetch(
              new Request(new URL(`${path}${url.search}`, base), request),
            );
            if (
              request.method === "POST" &&
              path === `/runs/${runId}/plan-state-metadata`
            ) {
              planMetadataStatus = upstream.status;
            }
            if (
              request.method === "PUT" &&
              path === `/runs/${runId}/mutation-preparation` &&
              upstream.status === 201
            ) {
              const reservation = (await upstream.clone().json()) as {
                epoch?: number;
              };
              if (typeof reservation.epoch === "number")
                epochs.push(reservation.epoch);
            }
            return upstream;
          },
        });

        const storedStates: LocalOpenTofuStateArtifact[] = [];
        const storedOutputs: unknown[] = [];
        const stateStore = {
          read: async (stateRef: string) =>
            storedStates.find((artifact) => artifact.stateRef === stateRef),
          commit: async (artifact: LocalOpenTofuStateArtifact) => {
            storedStates.push(artifact);
            return artifact;
          },
          readRawOutput: async () => undefined,
          commitRawOutput: async <T>(artifact: T) => {
            storedOutputs.push(artifact);
            return artifact;
          },
        };
        const runner = createHttpOpenTofuRunner({
          archiveStore: {
            write: async () => {},
            read: async () => archiveBytes,
          },
          stateStore,
          baseUrl: proxy.url.href,
        });
        const job = {
          applyRun: { id: runId },
          planRun: {
            id: planRunId,
            operation: "create",
            planDigest,
            source: {
              kind: "git",
              url: "https://git.example.test/pre-dispatch.git",
              commit: "0123456789abcdef0123456789abcdef01234567",
            },
            requiredProviders: [],
          },
          planArtifact: {
            kind: "runner-local",
            ref: `runner-local://${planRunId}/tfplan`,
            digest: planDigest,
            sizeBytes: planBytes.byteLength,
          },
          runnerProfile: createLocalOpenTofuRunnerProfile(),
          executionEvidenceAuthority: {
            controllerArtifact: {
              digest: `sha256:${"a".repeat(64)}`,
              immutable: true,
            },
            runnerArtifact: {
              digest: `sha256:${"b".repeat(64)}`,
              immutable: true,
            },
            executorArtifact: {
              digest: `sha256:${"c".repeat(64)}`,
              immutable: true,
            },
          },
          executionEvidenceCommit: {
            stateVersionId: `${runId}_state`,
            outputId: `${runId}_output`,
          },
          rawOutputRef: `${runId}_raw_output`,
          sourceArchive: {
            ref: `${runId}_source_archive`,
            digest: archiveDigest,
          },
          stateScope: {
            workspaceId: `${runId}_workspace`,
            subject: { kind: "resource", id: `${runId}_resource` },
            environment: "integration",
            generation: 1,
            stateRef: `${runId}_state_ref`,
          },
          variables: {},
        } as never;

        let firstFailure: unknown;
        try {
          await runner.apply!(job);
        } catch (error) {
          firstFailure = error;
        }
        expect(firstAttemptPlanWriteInterrupted).toBe(true);
        expect(firstFailure).toBeDefined();
        expect(firstFailure).not.toMatchObject({ status: "succeeded" });
        expect(applyPostCount).toBe(0);

        const resumed = await runner.apply!(job);
        expect(resumed.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
        expect(resumed.rawOutputRef).toBe(`${runId}_raw_output`);
        expect(attempts).toHaveLength(2);
        expect(attempts[0]).not.toBe(attempts[1]);
        expect(epochs).toContain(1);
        expect(epochs).toContain(2);
        expect(completionReads).toContainEqual({
          status: 202,
          body: { status: "preparing" },
        });
        expect(planMetadataReads).toBe(2);
        expect(planMetadataStatus).toBe(200);
        expect(staleAttemptWriteStatus).toBe(409);
        expect(applyPostCount).toBe(1);
        expect(storedStates).toHaveLength(1);
        expect(storedOutputs).toHaveLength(1);
        expect(
          (await readFile(applyCalls, "utf8")).trim().split("\n"),
        ).toHaveLength(1);

        if (!dispatchRequest)
          throw new Error("Runner dispatch request was not observed");
        const redelivery = await fetch(
          new Request(new URL(`/runs/${runId}`, base), dispatchRequest),
        );
        expect(redelivery.status).toBe(409);
        expect(await redelivery.json()).toMatchObject({
          errorCode: "runner_mutation_indeterminate",
          retryable: false,
        });
        expect(
          (await readFile(applyCalls, "utf8")).trim().split("\n"),
        ).toHaveLength(1);
      } finally {
        proxy?.stop(true);
        if (supervisor.exitCode === null) {
          supervisor.stdin.write("stop\n");
          expect(await lines.next()).toBe("stop-received");
          expect(await lines.next()).toBe("runner-settled");
          expect(await lines.next()).toBe("supervisor-closed");
          const closed = await lines.next();
          supervisorClosed = closed.startsWith("closed:0:");
          const exitCode = await supervisor.exited;
          if (supervisorClosed) expect(exitCode).toBe(0);
        }
        if (supervisorClosed)
          await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

function fakeTofu(callsFile: string): string {
  const quotedCalls = `'${callsFile.replaceAll("'", "'\\''")}'`;
  return `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  init) exit 0 ;;
  apply)
    printf '%s\\n' "$PWD" >> ${quotedCalls}
    printf '%s\\n' '{"version":4,"terraform_version":"1.10.0","serial":1,"lineage":"pre-dispatch-resume","outputs":{"fixture":{"value":"ok","type":"string","sensitive":false}},"resources":[]}' > terraform.tfstate
    exit 0
    ;;
  output) printf '%s' '{"fixture":{"value":"ok","type":"string","sensitive":false}}' ;;
  *) exit 97 ;;
esac
`;
}

function savedPlanFixture(): Uint8Array {
  const encoder = new TextEncoder();
  const entries = [
    { name: "tfplan", text: "opaque native plan fixture" },
    { name: "tfstate", text: '{"lineage":"","serial":0}' },
  ];
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const body = encoder.encode(entry.text);
    const compressed = new Uint8Array(deflateRawSync(body));
    const checksum = crc32(body);
    const local = new Uint8Array(30 + name.length + compressed.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(8, 8, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, compressed.length, true);
    localView.setUint32(22, body.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(compressed, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(10, 8, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, compressed.length, true);
    centralView.setUint32(24, body.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    localParts.push(local);
    centralParts.push(central);
    offset += local.length;
  }

  const directoryLength = centralParts.reduce(
    (sum, part) => sum + part.length,
    0,
  );
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, directoryLength, true);
  endView.setUint32(16, offset, true);

  const archive = new Uint8Array(offset + directoryLength + end.length);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  return archive;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function runSupervisorFixture(
  runRoot: string,
  portFile: string,
): Promise<void> {
  let owner: RunRootOwnership | undefined;
  let supervisor: PreparationV2ChildSupervisor | undefined;
  try {
    owner = await acquireRunRootOwnership(runRoot);
    supervisor = new PreparationV2ChildSupervisor(runRoot, owner);
    const env = Object.fromEntries(
      Object.entries(Bun.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const run = supervisor.runRunnerUntilDrained(
      process.execPath,
      [
        "--no-env-file",
        import.meta.path,
        "--pre-dispatch-resume-http-child",
        runRoot,
        portFile,
      ],
      { env, drainTimeoutMs: 5_000, retryIntervalMs: 20 },
    );
    const settled = run.then(
      (result) => ({ ok: true as const, result }),
      () => ({ ok: false as const }),
    );
    const port = await waitForPort(portFile, settled);
    process.stdout.write(`ready:${port}\n`);
    await waitForStopCommand();
    process.stdout.write("stop-received\n");
    if (!supervisor.signalRunner("SIGTERM"))
      throw new Error("runner stop refused");
    const outcome = await settled;
    process.stdout.write("runner-settled\n");
    if (
      !outcome.ok ||
      outcome.result.exitCode !== 0 ||
      outcome.result.signalCode !== null
    )
      throw new Error("Runner fixture did not exit cleanly");
    await supervisor.close();
    process.stdout.write("supervisor-closed\n");
    supervisor = undefined;
    await owner.close();
    process.stdout.write("closed:0:drained\n");
  } catch {
    process.stdout.write("fixture-failed\n");
    process.exitCode = 1;
  }
}

async function runHttpChildFixture(
  runRoot: string,
  portFile: string,
): Promise<void> {
  let owner: RunRootOwnership | undefined;
  try {
    owner = await adoptRunRootOwnershipFromStdin(runRoot);
    const running = await startRunnerHttpServer({
      hostname: "127.0.0.1",
      port: 0,
      localPreparationV2: true,
      runRootOwnership: owner,
    });
    owner = undefined;
    await writeFile(portFile, String(running.server.port), { flag: "wx" });
    process.on("SIGTERM", () => {
      void running.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
    await new Promise<void>(() => {});
  } catch {
    await owner?.close().catch(() => {});
    process.exitCode = 1;
  }
}

async function waitForPort(
  path: string,
  settled: Promise<{ readonly ok: true } | { readonly ok: false }>,
): Promise<number> {
  const deadline = performance.now() + 5_000;
  for (;;) {
    try {
      const port = Number(await readFile(path, "utf8"));
      if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) return port;
    } catch {
      // The child publishes this only after the HTTP listener is ready.
    }
    const result = await Promise.race([
      settled,
      Bun.sleep(10).then(() => undefined),
    ]);
    if (result && !result.ok)
      throw new Error("Runner child failed before listen");
    if (performance.now() >= deadline)
      throw new Error("Runner child listen timed out");
  }
}

function waitForStopCommand(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      if (!chunk.includes("stop\n")) return;
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve();
    };
    process.stdin.on("data", onData);
  });
}

function lineReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async next(): Promise<string> {
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          return line;
        }
        const { done, value } = await reader.read();
        if (done) throw new Error("supervisor fixture exited before status");
        buffered += decoder.decode(value, { stream: true });
      }
    },
  };
}
