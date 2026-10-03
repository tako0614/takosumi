#!/usr/bin/env -S bun --no-env-file

/**
 * Opt-in, local-only qualification of private v2 custody over real loopback
 * TCP with one long-lived Runner and two separate adapter client processes.
 * This is not Core/DB, Docker-image, hosted, or runner-restart evidence.
 */
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { createHttpOpenTofuRunner } from "../../deploy/node-postgres/src/local-opentofu-runner.ts";
import { handleRunnerRequestWithDependencies } from "../../runner/entrypoint.ts";
import { FIXTURE_EXECUTION_EVIDENCE_AUTHORITY } from "../helpers/deploy-control/model_fixture.ts";
import { boundedRunnerFetch } from "./local-core-http-lifecycle.ts";

const BUN_VERSION = "1.4.0";
const BUN_SHA256 = "33d56b070be6a9e3da0ab013038b43d1645d0534ca811ecdba4472599117eb4b";
const TOFU_PATH = "/usr/bin/tofu";
const TOFU_VERSION = "OpenTofu v1.12.3";
const TOFU_SHA256 = "d5e3276d613fdc070178ad6b0eb545f79a05e9aeae51f3c20024d21362fe25c6";
const MAX_PROTOCOL_LINE_BYTES = 4096;
const CHILD_DEADLINE_MS = 90_000;
const REPO_ROOT = resolve(import.meta.dir, "../..");
const SOURCE = {
  kind: "git",
  url: "https://git.example.invalid/local-v2-proof.git",
  commit: "0123456789abcdef0123456789abcdef01234567",
} as const;
const MODULE = `terraform {
  required_version = ">= 1.0"
}

resource "terraform_data" "probe" {
  input = "same-run-v2-tcp"
}

output "proof" {
  value = terraform_data.probe.output
}
`;

type ProofInput = {
  readonly baseUrl: string;
  readonly runId: string;
  readonly planId: string;
  readonly planDigest: string;
  readonly archivePath: string;
  readonly archiveDigest: string;
  readonly archiveSizeBytes: number;
};

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function jobFor(input: ProofInput) {
  return {
    applyRun: { id: input.runId },
    planRun: {
      id: input.planId,
      planDigest: input.planDigest,
      source: SOURCE,
      requiredProviders: [],
      providerLockArtifact: null,
    },
    planArtifact: {
      kind: "runner-local" as const,
      ref: `runner-local://${input.planId}/tfplan`,
      digest: input.planDigest,
    },
    sourceArchive: {
      ref: "proof-source-archive",
      digest: input.archiveDigest,
      sizeBytes: input.archiveSizeBytes,
    },
    runnerProfile: {
      id: "opentofu-default",
      executorId: "opentofu.default",
      allowedProviders: [],
    },
    credentials: { env: {} }, // Exact, deliberately empty synthetic envelope; no secret is persisted.
    executionEvidenceAuthority: FIXTURE_EXECUTION_EVIDENCE_AUTHORITY,
    executionEvidenceCommit: {
      stateVersionId: `state_${input.runId}`,
      outputId: `output_${input.runId}`,
    },
    stateScope: {
      workspaceId: "workspace_v2_tcp_proof",
      subject: { kind: "resource" as const, id: "resource_v2_tcp_proof" },
      environment: "integration",
      generation: 1,
      stateRef: `state://v2-tcp/${input.runId}`,
    },
    rawOutputRef: `output://v2-tcp/${input.runId}`,
  };
}

function clientInput(): ProofInput {
  const text = Bun.env.TAKOSUMI_V2_PROOF_INPUT;
  if (!text) throw new Error("client proof input is absent");
  const value = JSON.parse(text) as ProofInput;
  const origin = new URL(value.baseUrl);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(value.runId) ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(value.planId) ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.planDigest) ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.archiveDigest) ||
    !Number.isSafeInteger(value.archiveSizeBytes) || value.archiveSizeBytes < 1)
    throw new Error("client proof input is invalid");
  return value;
}

function requestParts(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  return { url, method, headers };
}

function protocolLine(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function client(mode: "a" | "b"): Promise<void> {
  const input = clientInput();
  const nativeFetch = globalThis.fetch;
  const bounded = boundedRunnerFetch(input.baseUrl, nativeFetch);
  let directStatus: number | undefined;
  let prepostSent = false;
  globalThis.fetch = (async (resource: RequestInfo | URL, init?: RequestInit) => {
    const { url, method, headers } = requestParts(resource, init);
    const planRestore = method === "PUT" &&
      url.pathname === `/runs/${input.runId}/artifacts/tfplan`;
    const dispatch = method === "POST" && url.pathname === `/runs/${input.runId}`;
    if (mode === "b" && dispatch) {
      assert(!prepostSent, "a client attempted a second provider POST");
      prepostSent = true;
      protocolLine({
        phase: "prepost",
        attemptId: headers.get("x-takosumi-preparation-attempt"),
        epoch: Number(headers.get("x-takosumi-preparation-epoch")),
      });
      const instruction = await new Response(Bun.stdin.stream()).text();
      assert.equal(instruction.trim(), "continue", "parent did not release provider POST");
    }
    const response = await bounded(resource, init);
    if (mode === "a" && planRestore && response.ok) {
      await response.arrayBuffer();
      protocolLine({
        phase: "prepared",
        attemptId: headers.get("x-takosumi-preparation-attempt"),
        epoch: Number(headers.get("x-takosumi-preparation-epoch")),
      });
      // Parent SIGKILLs this client after the Runner acknowledged preparation.
      await new Promise<never>(() => {});
    }
    if (mode === "b" && dispatch) {
      directStatus = response.status;
      const actual = await response.json() as Record<string, unknown>;
      assert.equal(directStatus, 200, "actual Runner apply did not succeed");
      assert.equal(actual.status, "succeeded", "actual Runner apply was not successful");
      // The real provider response is now deliberately lost to the adapter.
      return new Response("upstream acknowledgement lost", { status: 503 });
    }
    return response;
  }) as typeof fetch;
  const runner = createHttpOpenTofuRunner({
    baseUrl: input.baseUrl,
    archiveStore: {
      read: async () => new Uint8Array(await readFile(input.archivePath)),
      write: async () => { throw new Error("unexpected archive write"); },
    },
    stateStore: {
      read: async () => undefined,
      commit: async () => { throw new Error("unexpected state commit after unknown ACK"); },
      readRawOutput: async () => undefined,
      commitRawOutput: async () => { throw new Error("unexpected Output commit after unknown ACK"); },
    },
  });
  try {
    await runner.apply(jobFor(input) as Parameters<typeof runner.apply>[0]);
    throw new Error("adapter falsely reported success after unknown acknowledgement");
  } catch (error) {
    if (mode === "a") throw error;
    assert(prepostSent, "client B never reached provider dispatch");
    assert.equal(directStatus, 200, "real Runner success was not observed");
    assert.equal(
      (error as { readonly reason?: unknown }).reason,
      "runner_mutation_indeterminate",
      "adapter did not preserve unknown-ACK indeterminacy",
    );
    protocolLine({ phase: "indeterminate", directStatus });
  } finally {
    globalThis.fetch = nativeFetch;
  }
}

async function runnerServer(): Promise<void> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => handleRunnerRequestWithDependencies(request, {
      mutationCustodyMode: "local-http",
      localPreparationV2: true,
    }),
  });
  protocolLine({ phase: "ready", port: server.port, pid: process.pid });
}

class LineReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer = "";
  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }
  async next(): Promise<Record<string, unknown>> {
    while (!this.#buffer.includes("\n")) {
      const chunk = await this.#reader.read();
      if (chunk.done) throw new Error("proof child closed stdout before its protocol line");
      this.#buffer += new TextDecoder().decode(chunk.value);
      if (Buffer.byteLength(this.#buffer) > MAX_PROTOCOL_LINE_BYTES)
        throw new Error("proof child protocol exceeds byte cap");
    }
    const newline = this.#buffer.indexOf("\n");
    const line = this.#buffer.slice(0, newline);
    this.#buffer = this.#buffer.slice(newline + 1);
    const value = JSON.parse(line) as unknown;
    assert(value && typeof value === "object" && !Array.isArray(value), "invalid child protocol");
    return value as Record<string, unknown>;
  }
}

type Child = ReturnType<typeof Bun.spawn>;
type ProcessIdentity = { readonly startTicks: string; readonly exe: string };
type OwnedChild = { readonly child: Child; readonly pid: number; readonly identity: ProcessIdentity };

function childIsTerminal(child: Child): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function captureOwnedChild(child: Child): Promise<OwnedChild> {
  assert(Number.isSafeInteger(child.pid) && child.pid > 0, "owned child PID is invalid");
  return { child, pid: child.pid, identity: await processIdentity(child.pid) };
}

async function stopOwnedChild(
  owned: OwnedChild | undefined, signal: NodeJS.Signals = "SIGKILL",
): Promise<boolean> {
  if (!owned) return false;
  const { child, pid, identity } = owned;
  if (childIsTerminal(child)) {
    await child.exited;
    return false;
  }
  assert.deepEqual(await processIdentity(pid), identity, "owned child identity changed before signal");
  if (childIsTerminal(child)) {
    await child.exited;
    return false;
  }
  child.kill(signal);
  await child.exited;
  return true;
}

async function drainChildStderr(child: Child): Promise<void> {
  const reader = child.stderr.getReader();
  try {
    while (!(await reader.read()).done) {
      // Keep the pipe flowing without recording Runner/provider output.
    }
  } finally {
    reader.releaseLock();
  }
}

async function checkedCommand(
  command: readonly string[], cwd: string, env: Record<string, string>,
): Promise<string> {
  const child = Bun.spawn([...command], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const owner = await captureOwnedChild(child).catch((error) => {
    if (!childIsTerminal(child)) throw error;
    return undefined;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void stopOwnedChild(owner).catch(() => {});
      reject(new Error(`native proof command timed out: ${command[0]}`));
    }, CHILD_DEADLINE_MS);
  });
  try {
    const [stdout, stderr, exit] = await Promise.race([
      Promise.all([stdoutPromise, stderrPromise, child.exited]), timeout,
    ]);
    assert.equal(exit, 0, `native proof command failed: ${command[0]} (${stderr.slice(0, 512)})`);
    assert(Buffer.byteLength(stdout) < 64 * 1024, "native proof command output too large");
    return stdout.trim();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function processIdentity(pid: number): Promise<ProcessIdentity> {
  const data = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = data.slice(data.lastIndexOf(")") + 2).trim().split(/\s+/u);
  const startTicks = fields[19]; // Linux stat field 22; fields[] begins at field 3.
  assert(startTicks && /^\d+$/u.test(startTicks), "runner startTicks are unavailable");
  const exe = await readlink(`/proc/${pid}/exe`);
  const after = await readFile(`/proc/${pid}/stat`, "utf8");
  const afterFields = after.slice(after.lastIndexOf(")") + 2).trim().split(/\s+/u);
  assert.equal(afterFields[19], startTicks, "owned process changed while reading identity");
  return { startTicks, exe };
}

async function completedApplyGroupIsEmpty(scopePath: string): Promise<boolean> {
  const lines = (await readFile(scopePath, "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 2, "OpenTofu child scope record is incomplete");
  const stat = lines[0]!;
  const statPid = Number(stat.slice(0, stat.indexOf(" ")));
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
  const pgrp = Number(fields[2]); // Linux stat field 5; fields[] begins at field 3.
  const startTicks = fields[19];
  assert(Number.isSafeInteger(statPid) && statPid > 0 &&
    pgrp === statPid && /^\d+$/u.test(startTicks ?? "") &&
    lines[1] === await realpath("/bin/sh"), "OpenTofu child scope identity is invalid");
  try {
    process.kill(-pgrp, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function cleanupProofRoot(
  root: string,
  proofResult: Record<string, unknown> | undefined,
  deadlineFired: boolean,
  childrenStopped: boolean,
  applyScopePath: string | undefined,
): Promise<boolean> {
  let toolScopeEmpty = false;
  if (proofResult && !deadlineFired && childrenStopped && applyScopePath) {
    toolScopeEmpty = await completedApplyGroupIsEmpty(applyScopePath).catch(() => false);
  }
  // Failure/timeout never deletes a possible detached OpenTofu writer's root.
  if (!proofResult || deadlineFired || !childrenStopped || !toolScopeEmpty) return false;
  await rm(root, { recursive: true, force: true });
  return true;
}

async function cleanupGuardSelfTest(): Promise<void> {
  const root = await mkdtemp(join(dirname(REPO_ROOT), "takosumi-local-v2-cleanup-"));
  const marker = join(root, "retained-marker");
  const bunPath = await realpath(process.execPath);
  const ownedChildren: OwnedChild[] = [];
  let passed = false;
  try {
    await chmod(root, 0o700);
    const home = join(root, "home");
    const tmp = join(root, "tmp");
    await mkdir(home, { mode: 0o700 });
    await mkdir(tmp, { mode: 0o700 });
    await writeFile(marker, "retained", { mode: 0o600 });
    assert.equal(await cleanupProofRoot(root, undefined, false, true, undefined), false);
    assert.equal(await cleanupProofRoot(root, { status: "passed" }, true, true, undefined), false);
    assert.equal(await cleanupProofRoot(root, { status: "passed" }, false, false, undefined), false);
    assert.equal(await cleanupProofRoot(root, { status: "passed" }, false, true, marker), false);
    assert.equal(await readFile(marker, "utf8"), "retained");
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const child = Bun.spawn([
        bunPath, "--no-env-file", "-e", "setInterval(() => {}, 1000)",
      ], {
        cwd: REPO_ROOT,
        env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: tmp },
        stdout: "pipe", stderr: "pipe",
      });
      void drainChildStderr(child).catch(() => {});
      void new Response(child.stdout).text().catch(() => {});
      const owned = await captureOwnedChild(child);
      ownedChildren.push(owned);
      if (signal === "SIGTERM") {
        await assert.rejects(
          stopOwnedChild({ ...owned, identity: { ...owned.identity, startTicks: "0" } }, signal),
          /identity changed before signal/u,
        );
        assert(!childIsTerminal(child), "mismatched child identity was signalled");
      }
      assert.equal(await stopOwnedChild(owned, signal), true, "live owned child was not signalled");
      assert(child.signalCode !== null, "signalled child has no terminal signal status");
      assert.equal(await stopOwnedChild(owned), false, "terminal child was signalled again");
    }
    passed = true;
  } finally {
    let childrenStopped = true;
    for (const owned of ownedChildren) {
      try {
        await stopOwnedChild(owned);
      } catch {
        childrenStopped = false;
      }
    }
    if (passed && childrenStopped) {
      await rm(root, { recursive: true, force: true });
    } else {
      process.stderr.write(`local v2 cleanup self-test retained private workspace: ${root}\n`);
      if (passed) throw new Error("cleanup self-test child shutdown is uncertain");
    }
  }
  protocolLine({ status: "cleanup-guard-passed" });
}

async function runnerFetch(baseUrl: string, path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(path, baseUrl);
  assert.equal(url.hostname, "127.0.0.1", "proof refused non-loopback HTTP");
  return await fetch(url, { ...init, signal: AbortSignal.timeout(45_000) });
}

async function prove(): Promise<void> {
  assert.equal(Bun.version, BUN_VERSION, "proof requires pinned Bun 1.4.0");
  const bunPath = await realpath(process.execPath);
  assert.equal(
    digest(new Uint8Array(await readFile(bunPath))),
    `sha256:${BUN_SHA256}`,
    "Bun executable bytes are not qualified",
  );
  const tofuPath = await realpath(TOFU_PATH);
  const tofuHash = digest(new Uint8Array(await readFile(tofuPath)));
  assert.equal(tofuHash, `sha256:${TOFU_SHA256}`, "installed OpenTofu bytes are not qualified");
  const root = await mkdtemp(join(dirname(REPO_ROOT), "takosumi-local-v2-tcp-"));
  let runner: Child | undefined;
  let clientA: Child | undefined;
  let clientB: Child | undefined;
  let ownedRunner: OwnedChild | undefined;
  let ownedClientA: OwnedChild | undefined;
  let ownedClientB: OwnedChild | undefined;
  let proofResult: Record<string, unknown> | undefined;
  let applyScopePath: string | undefined;
  let deadlineFired = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let deadlineStop: Promise<unknown> | undefined;
  try {
    await chmod(root, 0o700);
    const homeDir = join(root, "home");
    const tmpDir = join(root, "tmp");
    await mkdir(homeDir, { mode: 0o700 });
    await mkdir(tmpDir, { mode: 0o700 });
    const commandEnv = {
      PATH: "/usr/bin:/bin", HOME: homeDir, TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir,
      LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0",
    };
    const tofuVersion = await checkedCommand([tofuPath, "version"], REPO_ROOT, commandEnv);
    assert.equal(tofuVersion.split("\n")[0], TOFU_VERSION, "installed OpenTofu version is not qualified");
    const runId = `apply_v2_tcp_${randomUUID().replaceAll("-", "")}`;
    const planId = `plan_v2_tcp_${randomUUID().replaceAll("-", "")}`;
    const moduleDir = join(root, "module");
    const archiveTar = join(root, "source.tar");
    const archivePath = join(root, "source.tar.zst");
    const binDir = join(root, "bin");
    const applyCalls = join(root, "tofu-apply-calls");
    const applyScope = join(root, "tofu-apply-scope");
    applyScopePath = applyScope;
    await mkdir(moduleDir, { mode: 0o700 });
    await mkdir(binDir, { mode: 0o700 });
    await writeFile(join(moduleDir, "main.tf"), MODULE, { mode: 0o600 });
    await checkedCommand([
      "/usr/bin/tar", "--sort=name", "--numeric-owner", "--owner=0", "--group=0",
      "--mtime=@0", "--format=gnu", "-C", moduleDir, "-cf", archiveTar, ".",
    ], root, commandEnv);
    await checkedCommand(["/usr/bin/zstd", "-q", "-f", "-o", archivePath, archiveTar], root, commandEnv);
    const archiveBytes = new Uint8Array(await readFile(archivePath));
    const archiveDigest = digest(archiveBytes);
    const wrapper = join(binDir, "tofu");
    await writeFile(wrapper, `#!/bin/sh\nif [ "$1" = apply ]; then\n  IFS= read -r stat < "/proc/$$/stat"\n  printf '%s\\n' "$stat" > '${applyScope}'\n  /usr/bin/readlink "/proc/$$/exe" >> '${applyScope}'\n  printf 'apply\\n' >> '${applyCalls}'\nfi\nexec '${tofuPath}' "$@"\n`, { mode: 0o700 });
    runner = Bun.spawn([bunPath, "--no-env-file", import.meta.path, "--runner"], {
      cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe",
      env: {
        ...commandEnv,
        PATH: `${binDir}:/usr/bin:/bin`,
        TAKOSUMI_OPENTOFU_RUN_ROOT: join(root, "runs"),
      },
    });
    ownedRunner = await captureOwnedChild(runner);
    deadline = setTimeout(() => {
      deadlineFired = true;
      deadlineStop = Promise.allSettled([
        stopOwnedChild(ownedClientB), stopOwnedChild(ownedClientA), stopOwnedChild(ownedRunner),
      ]);
    }, 180_000);
    void drainChildStderr(runner).catch(() => {});
    const runnerLines = new LineReader(runner.stdout);
    const ready = await runnerLines.next();
    assert.equal(ready.phase, "ready");
    assert.equal(ready.pid, runner.pid);
    assert(Number.isSafeInteger(ready.port) && Number(ready.port) > 0);
    const baseUrl = `http://127.0.0.1:${ready.port}/`;
    const identity = ownedRunner.identity;
    assert.deepEqual(await processIdentity(runner.pid), identity, "Runner identity changed before readiness");
    const health = await runnerFetch(baseUrl, "/healthz");
    const healthBody = await health.json() as Record<string, unknown>;
    assert.equal(healthBody.mutationCustodyMode, "local-http");
    assert(Array.isArray(healthBody.capabilities) &&
      healthBody.capabilities.includes("takosumi.local-mutation-preparation@v2"));
    const planRestore = await runnerFetch(baseUrl, `/runs/${planId}/source-archive/restore`, {
      method: "PUT", headers: { "content-type": "application/zstd" }, body: archiveBytes,
    });
    assert.equal(planRestore.status, 200, "real Runner source restore failed");
    const planResponse = await runnerFetch(baseUrl, `/runs/${planId}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1", runId: planId, action: "plan",
        request: {
          planRun: { id: planId, operation: "create", source: SOURCE, requiredProviders: [] },
          variables: {},
          runnerProfile: { id: "opentofu-default", executorId: "opentofu.default", allowedProviders: [] },
        },
      }),
    });
    assert.equal(planResponse.status, 200, "real Runner Plan failed");
    const plan = await planResponse.json() as Record<string, unknown>;
    assert.equal(plan.status, "succeeded");
    assert.equal(plan.providerLockArtifact, null, "builtin-only Plan acquired an external provider lock");
    assert(typeof plan.planDigest === "string" && /^sha256:[0-9a-f]{64}$/u.test(plan.planDigest));
    const planArtifact = await runnerFetch(baseUrl, `/runs/${planId}/artifacts/tfplan`);
    assert.equal(planArtifact.status, 200);
    const originalPlan = new Uint8Array(await planArtifact.arrayBuffer());
    assert.equal(digest(originalPlan), plan.planDigest);
    const input: ProofInput = {
      baseUrl, runId, planId, planDigest: plan.planDigest,
      archivePath, archiveDigest, archiveSizeBytes: archiveBytes.byteLength,
    };
    const clientEnv = { ...commandEnv, TAKOSUMI_V2_PROOF_INPUT: JSON.stringify(input) };
    clientA = Bun.spawn([bunPath, "--no-env-file", import.meta.path, "--client-a"], {
      cwd: REPO_ROOT, env: clientEnv, stdout: "pipe", stderr: "pipe",
    });
    ownedClientA = await captureOwnedChild(clientA);
    void drainChildStderr(clientA).catch(() => {});
    const paused = await new LineReader(clientA.stdout).next();
    assert.equal(paused.phase, "prepared");
    assert.equal(paused.epoch, 1);
    assert(typeof paused.attemptId === "string" && /^[0-9a-f-]{36}$/u.test(paused.attemptId));
    assert(await stopOwnedChild(ownedClientA), "client A was not interrupted as a live process");
    assert(clientA.signalCode !== null, "interrupted client A has no terminal signal status");
    assert.deepEqual(await processIdentity(runner.pid), identity, "Runner changed across client A interruption");
    clientB = Bun.spawn([bunPath, "--no-env-file", import.meta.path, "--client-b"], {
      cwd: REPO_ROOT, env: clientEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    ownedClientB = await captureOwnedChild(clientB);
    void drainChildStderr(clientB).catch(() => {});
    const clientBLines = new LineReader(clientB.stdout);
    const prepost = await clientBLines.next();
    assert.equal(prepost.phase, "prepost");
    assert.equal(prepost.epoch, 2);
    assert(typeof prepost.attemptId === "string" && /^[0-9a-f-]{36}$/u.test(prepost.attemptId));
    assert.notEqual(prepost.attemptId, paused.attemptId);
    assert.deepEqual(await processIdentity(runner.pid), identity, "Runner changed during owner transfer");
    const staleHeaders = {
      "x-takosumi-preparation-attempt": paused.attemptId,
      "x-takosumi-preparation-epoch": "1",
    };
    const staleRestore = await runnerFetch(baseUrl, `/runs/${runId}/source-archive/restore`, {
      method: "PUT", headers: staleHeaders, body: archiveBytes,
    });
    assert.equal(staleRestore.status, 409, "stale A could replace B's source");
    const stalePost = await runnerFetch(baseUrl, `/runs/${runId}`, {
      method: "POST", headers: { "content-type": "application/json", ...staleHeaders },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1", runId, action: "apply", request: jobFor(input),
      }),
    });
    assert.equal(stalePost.status, 409, "stale A could dispatch");
    const currentPlan = await runnerFetch(baseUrl, `/runs/${runId}/artifacts/tfplan`);
    assert.equal(currentPlan.status, 200);
    assert.equal(digest(new Uint8Array(await currentPlan.arrayBuffer())), plan.planDigest);
    assert.deepEqual(await processIdentity(runner.pid), identity);
    clientB.stdin.write("continue\n");
    clientB.stdin.end();
    const indeterminate = await clientBLines.next();
    assert.equal(indeterminate.phase, "indeterminate");
    assert.equal(indeterminate.directStatus, 200);
    assert.equal(await clientB.exited, 0);
    const claimName = digest(new TextEncoder().encode(runId)).slice(7);
    const claimPath = join(root, "runs", ".mutation-custody", `${claimName}.claim.json`);
    const claim = JSON.parse(await readFile(claimPath, "utf8")) as Record<string, unknown>;
    const dispatched = JSON.parse(await readFile(`${claimPath}.dispatched`, "utf8")) as Record<string, unknown>;
    const completion = JSON.parse(await readFile(
      join(root, "runs", ".mutation-custody", `${claimName}.completion.json`), "utf8",
    )) as Record<string, unknown>;
    assert.equal(claim.kind, "takosumi.local-mutation-preparation@v2");
    assert.equal(dispatched.kind, "takosumi.local-mutation-dispatched@v2");
    assert.equal(completion.kind, "takosumi.local-mutation-completion@v2");
    assert.equal(completion.outcome, "other", "successful result must not be adopted from readback");
    assert.equal(completion.epoch, 2);
    assert.equal(dispatched.requestDigest, claim.requestDigest);
    assert.equal(completion.requestDigest, claim.requestDigest);
    const duplicate = await runnerFetch(baseUrl, `/runs/${runId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-takosumi-preparation-attempt": prepost.attemptId,
        "x-takosumi-preparation-epoch": "2",
      },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run@v1", runId, action: "apply", request: jobFor(input),
      }),
    });
    assert.equal(duplicate.status, 409, "unknown ACK allowed a second provider POST");
    const receipt = await runnerFetch(baseUrl, `/runs/${runId}/completion`, {
      headers: {
        "x-takosumi-mutation-action": "apply",
        "x-takosumi-mutation-digest": claim.requestDigest as string,
      },
    });
    assert.equal(receipt.status, 409, "successful private completion must stay indeterminate");
    const state = await runnerFetch(baseUrl, `/runs/${runId}/artifacts/tfstate`);
    assert.equal(state.status, 200);
    const stateBytes = new Uint8Array(await state.arrayBuffer());
    const stateBody = JSON.parse(new TextDecoder().decode(stateBytes)) as {
      readonly resources?: readonly { readonly type?: string }[];
    };
    assert(stateBody.resources?.some((resource) => resource.type === "terraform_data"));
    assert.equal(await readFile(applyCalls, "utf8"), "apply\n", "real tofu apply did not run exactly once");
    assert.deepEqual(await processIdentity(runner.pid), identity, "Runner changed during client B or readback");
    assert(await completedApplyGroupIsEmpty(applyScope), "owned OpenTofu process group is still active");
    assert(!deadlineFired, "native proof deadline expired");
    proofResult = {
      status: "passed", runnerPid: runner.pid, runnerStartTicks: identity.startTicks,
      runnerExe: identity.exe, tofuVersion: tofuVersion.split("\n")[0], tofuSha256: tofuHash,
      planDigest: plan.planDigest, stateDigest: digest(stateBytes),
      clientAInterrupted: true, transferEpoch: 2, staleWriterStatus: staleRestore.status,
      staleDispatchStatus: stalePost.status, duplicateDispatchStatus: duplicate.status,
      completionReadbackStatus: receipt.status, applyExecutions: 1,
    };
  } finally {
    if (deadline) clearTimeout(deadline);
    await deadlineStop;
    let childrenStopped = true;
    for (const [child, owned] of [
      [clientB, ownedClientB], [clientA, ownedClientA], [runner, ownedRunner],
    ] as const) {
      try {
        if (child && !owned && !childIsTerminal(child)) {
          throw new Error("live proof child has no captured identity");
        }
        await stopOwnedChild(owned);
      } catch {
        childrenStopped = false;
      }
    }
    const removed = await cleanupProofRoot(
      root, proofResult, deadlineFired, childrenStopped, applyScopePath,
    );
    if (!removed) {
      process.stderr.write(`local v2 TCP proof retained private workspace after uncertain execution: ${root}\n`);
      if (proofResult) throw new Error("native proof cleanup is uncertain; private workspace retained");
    }
  }
  assert(proofResult, "native proof result is absent");
  protocolLine(proofResult);
}

if (import.meta.main) {
  const mode = Bun.argv[2];
  try {
    if (mode === "--runner") await runnerServer();
    else if (mode === "--client-a") await client("a");
    else if (mode === "--client-b") await client("b");
    else if (mode === "--cleanup-selftest") await cleanupGuardSelfTest();
    else if (mode === undefined) await prove();
    else throw new Error("unknown local v2 TCP proof mode");
  } catch (error) {
    process.stderr.write(`local v2 TCP proof failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
