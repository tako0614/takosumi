import { expect, test, afterAll } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenTofuApplyJob } from "../../../../core/domains/deploy-control/mod.ts";
import type { PlanRun } from "@takosumi/internal/deploy-control-api";

if (Bun.env.TAKOSUMI_COMPLETION_CUSTODY_TEST_CHILD !== "1") {
  test("local completion custody recovery in an owned private Runner root", async () => {
    const root = await mkdtemp(join(tmpdir(), "takosumi-completion-custody-"));
    await chmod(root, 0o700);
    await mkdir(join(root, "runs"), { mode: 0o700 });
    const child = Bun.spawn([process.execPath, "--no-env-file", "test", import.meta.path], {
      env: { ...process.env, TAKOSUMI_COMPLETION_CUSTODY_TEST_CHILD: "1", TAKOSUMI_OPENTOFU_RUN_ROOT: join(root, "runs") },
      stdout: "pipe", stderr: "pipe",
    });
    let killed = false;
    const timeout = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, 30_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (exit !== 0 || killed || !/3 pass\s+0 fail/u.test(stdout + stderr)) throw new Error(`completion custody child failed (exit ${exit}, timeout ${killed})\n${stdout}\n${stderr}`);
      console.log(stdout + stderr);
      console.log("completion custody child: 3 pass, 0 fail");
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
      if (!killed) await rm(root, { recursive: true, force: true });
    }
  }, 35_000);
} else {
const { createHttpOpenTofuRunner, createFileOpenTofuStateArtifactStore, createLocalOpenTofuRunnerProfile } = await import("../../../../deploy/node-postgres/src/local-opentofu-runner.ts");
const { withCommittedLocalApplyRecovery } = await import("../../../../deploy/node-postgres/src/local-apply-recovery-capability.ts");
const { applyExpectedGuardFromPlanRun } = await import("../../../../core/domains/deploy-control/mod.ts");
const { PartitionedSecretBoundaryCrypto } = await import("../../../../core/adapters/secret-store/memory.ts");
const { digestBytes } = await import("../../../../runner/lib/util.ts");
const { handleRunnerRequestWithDependencies } = await import("../../../../runner/entrypoint.ts");
const { acquireRunRootOwnership } = await import("../../../../runner/lib/run_root_ownership.ts");
const { ensureCustodyDirectory } = await import("../../../../runner/lib/run_completion.ts");
const { RUN_ROOT } = await import("../../../../runner/lib/constants.ts");
const ROOT = join(RUN_ROOT, "..", "fixture");
const ARTIFACTS = join(ROOT, "artifacts");
const ENTERED = join(ROOT, "entered");
const RELEASE = join(ROOT, "release");
const EFFECTS = join(ROOT, "effects");
const stateCrypto = () => new PartitionedSecretBoundaryCrypto({ globalPassphrase: "completion-custody-synthetic-passphrase-32-bytes" });
let runner: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.serve>;
let foreign: ReturnType<typeof Bun.serve>;
let ownership: Awaited<ReturnType<typeof acquireRunRootOwnership>>;
let upstream: Promise<Response> | undefined;
let gateFirstResponse = true;
let loseCompletedAck = false;
let mode: "normal" | "miss" | "corrupt" | "state" | "redirect" = "normal";
let foreignReads = 0;
const requests: { method: string; path: string }[] = [];

async function ready() {
  await mkdir(ROOT, { recursive: true });
  const bin = join(ROOT, "bin");
  const source = join(ROOT, "source");
  await mkdir(bin, { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "main.tf"), "terraform {}\n");
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  await writeFile(join(bin, "tofu"), `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  init) exit 0 ;;
  apply)
    printf '%s\\n' "$PWD" >> ${quote(EFFECTS)}
    touch ${quote(ENTERED)}
    while [[ ! -f ${quote(RELEASE)} ]]; do sleep 0.01; done
    printf '%s' '{"version":4,"terraform_version":"1.10.0","serial":1,"lineage":"completion-custody","outputs":{"fixture":{"value":"ok","type":"string","sensitive":false}},"resources":[]}' > terraform.tfstate
    ;;
  output) printf '%s' '{"fixture":{"value":"ok","type":"string","sensitive":false}}' ;;
  *) exit 97 ;;
esac
`, { mode: 0o700 });
  Bun.env.PATH = `${bin}:${Bun.env.PATH}`;
  const archive = join(ROOT, "source.tar.zst");
  const tar = spawnSync("tar", ["--zstd", "-cf", archive, "-C", source, "."], { encoding: "utf8" });
  if (tar.status !== 0) throw new Error("fixture source archive failed");
  await ensureCustodyDirectory(true);
  ownership = await acquireRunRootOwnership(RUN_ROOT);
  runner = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => handleRunnerRequestWithDependencies(request, { mutationCustodyMode: "local-http", localPreparationV2: true, runRootOwnership: ownership }) });
  foreign = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { foreignReads++; return new Response("must not follow"); } });
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push({ method: request.method, path });
    const forwarded = new Request(new URL(path, runner.url), { method: request.method, headers: request.headers, ...(request.method === "GET" ? {} : { body: await request.arrayBuffer() }) });
    if (request.method === "POST" && /^\/runs\/[^/]+$/u.test(path)) {
      if (gateFirstResponse) {
        gateFirstResponse = false;
        upstream = fetch(forwarded); // independent owned Runner work survives this client error
        const deadline = performance.now() + 5_000;
        while (!(await Bun.file(ENTERED).exists())) {
          if (performance.now() >= deadline) throw new Error("Runner did not reach the fixture barrier");
          await Bun.sleep(5);
        }
        return Response.json({ errorCode: "fixture_response_lost" }, { status: 504 });
      }
      const response = await fetch(forwarded);
      if (loseCompletedAck) { loseCompletedAck = false; await response.arrayBuffer(); return Response.json({ errorCode: "fixture_completed_ack_lost" }, { status: 504 }); }
      return response;
    }
    if (request.method === "GET" && path.endsWith("/completion")) {
      if (mode === "miss") return Response.json({ errorCode: "runner_mutation_indeterminate" }, { status: 409 });
      if (mode === "redirect") return new Response(null, { status: 302, headers: { location: foreign.url.href } });
      const response = await fetch(forwarded);
      if (mode === "corrupt" && response.status === 200) { const body = await response.json(); return Response.json({ ...body, resultDigest: `sha256:${"0".repeat(64)}` }); }
      return response;
    }
    if (mode === "state" && request.method === "GET" && path.endsWith("/artifacts/tfstate")) return new Response("different-state");
    return await fetch(forwarded);
  } });
  return new Uint8Array(await readFile(archive));
}
const archiveBytes = await ready();
const archiveDigest = await digestBytes(archiveBytes);
const planBytes = savedPlanFixture();
const planDigest = await digestBytes(planBytes);
const profile = createLocalOpenTofuRunnerProfile(1);
const stateBackendRef = (() => {
  const ref = profile.stateBackend.ref;
  if (!ref) throw new Error("fixture profile must have a state backend ref");
  return ref;
})();
const archiveStore = { write: async () => {}, read: async () => archiveBytes };
function makeNode(store = createFileOpenTofuStateArtifactStore(ARTIFACTS, stateCrypto()), baseUrl = proxy.url.href) {
  return { store, adapter: createHttpOpenTofuRunner({ archiveStore, stateStore: store, baseUrl }) };
}
async function job(name: string): Promise<OpenTofuApplyJob> {
  const id = `apply_${name}`;
  const planId = `plan_${name}`;
  expect((await fetch(new URL(`/runs/${planId}/artifacts/tfplan`, runner.url), { method: "PUT", headers: { "content-type": "application/vnd.opentofu.plan" }, body: planBytes.buffer as ArrayBuffer })).ok).toBe(true);
  const plan: PlanRun = { id: planId, workspaceId: "workspace_fixture", capsuleId: `capsule_${name}`, operation: "create", runnerProfileId: profile.id, capsuleCurrentStateVersionId: null,
    source: { kind: "git", url: "https://git.example.test/custody.git", commit: "0123456789abcdef0123456789abcdef01234567" }, sourceDigest: archiveDigest,
    requiredProviders: [], status: "succeeded", policy: { status: "passed", reasons: [], checkedAt: 1 }, policyDecisionDigest: `sha256:${"d".repeat(64)}`, variablesDigest: `sha256:${"e".repeat(64)}`,
    planDigest, planArtifact: { kind: "runner-local", ref: `runner-local://${planId}/tfplan`, digest: planDigest, sizeBytes: planBytes.byteLength }, auditEvents: [], createdAt: 1, updatedAt: 1 };
  return { planRun: plan, planArtifact: plan.planArtifact!, runnerProfile: profile,
    applyRun: { id, planRunId: planId, workspaceId: plan.workspaceId, capsuleId: plan.capsuleId, operation: "create", runnerProfileId: profile.id, status: "running",
      expected: applyExpectedGuardFromPlanRun(plan), stateBackend: profile.stateBackend, stateLock: { status: "pending", backendRef: stateBackendRef },
      auditEvents: [{ id: `${id}_audit`, type: "apply.queued", at: 1, data: { fixture: "raw-job-canary-must-not-be-persisted" } }], createdAt: 1, updatedAt: 1, heartbeatAt: 1 },
    executionEvidenceAuthority: { controllerArtifact: { digest: `sha256:${"a".repeat(64)}`, immutable: true }, runnerArtifact: { digest: `sha256:${"b".repeat(64)}`, immutable: true }, executorArtifact: { digest: `sha256:${"c".repeat(64)}`, immutable: true } },
    executionEvidenceCommit: { stateVersionId: `${id}_state`, outputId: `${id}_output` }, rawOutputRef: `${id}_raw`, sourceArchive: { ref: `${id}_source`, digest: archiveDigest },
    stateScope: { workspaceId: plan.workspaceId, subject: { kind: "capsule", id: plan.capsuleId! }, environment: "integration", generation: 1, stateRef: `${id}_state_ref` } };
}
async function inventory(path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) Object.assign(out, await inventory(join(path, entry.name)));
    else out[join(path, entry.name)] = await digestBytes(new Uint8Array(await readFile(join(path, entry.name))));
  }
  return out;
}

test("completed independent Runner work is adopted from original encrypted dispatch custody", async () => {
  const request = await job("recovery");
  const original = makeNode();
  let firstError: unknown;
  try { await original.adapter.apply(request); } catch (error) { firstError = error; }
  expect(firstError).toBeDefined();
  const before = await inventory(ARTIFACTS);
  expect(await original.store.read(request.stateScope!.stateRef)).toBeUndefined();
  await writeFile(RELEASE, "release");
  expect((await upstream!).status).toBe(200);
  expect(await inventory(ARTIFACTS)).toEqual(before); // Runner completion does not pretend Node stored state
  const fresh = makeNode();
  const pendingBinding = `sha256:${require("node:crypto").createHash("sha256").update(JSON.stringify({ kind: "local-http-v2", endpoint: proxy.url.href })).digest("hex")}`;
  const pending = await fresh.store.readApplyDispatchCustody?.({ runId: request.applyRun.id, stateScope: request.stateScope!, runnerBindingDigest: pendingBinding });
  if (pending) {
    for (const failure of ["miss", "corrupt", "redirect", "state"] as const) {
      mode = failure;
      await expect(withCommittedLocalApplyRecovery(fresh.adapter, { runId: request.applyRun.id, stateScope: request.stateScope! }, async () => { throw new Error("must remain unconfirmed"); })).rejects.toThrow();
      expect(await fresh.store.read(request.stateScope!.stateRef)).toBeUndefined();
    }
    mode = "normal";
    expect(foreignReads).toBe(0);
    expect(await withCommittedLocalApplyRecovery(fresh.adapter, { runId: request.applyRun.id, stateScope: { ...request.stateScope!, generation: 2 } }, async () => {})).toBe(false);
    const changedBinding = makeNode(fresh.store, runner.url.href);
    expect(await withCommittedLocalApplyRecovery(changedBinding.adapter, { runId: request.applyRun.id, stateScope: request.stateScope! }, async () => {})).toBe(false);
    const readerScript = `import { inspectLocalMutationPreparationCompletion } from ${JSON.stringify(new URL("../../../../runner/lib/run_completion.ts", import.meta.url).pathname)}; const input=JSON.parse(await Bun.stdin.text()); console.log(await inspectLocalMutationPreparationCompletion(input.runId,"apply",input.requestDigest,input.restoredProviderLockDigest));`;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e", readerScript], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    child.stdin.write(JSON.stringify({ runId: pending.runId, requestDigest: pending.requestDigest, restoredProviderLockDigest: pending.restoredProviderLockDigest })); child.stdin.end();
    const [status, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(exit).toBe(0); expect(status.trim()).toBe("indeterminate");
  }
  const start = requests.length;
  let consumed = 0;
  const recovered = await withCommittedLocalApplyRecovery(fresh.adapter, { runId: request.applyRun.id, stateScope: request.stateScope! }, async () => {
    consumed++;
    const result = await fresh.adapter.apply({ ...request, applyRun: { ...request.applyRun, heartbeatAt: 99 } });
    expect(result.executionEvidence?.authority.controllerArtifact).toEqual(request.executionEvidenceAuthority!.controllerArtifact);
    expect(result.executionEvidence?.planRunId).toBe(request.planRun.id);
    expect(result.executionEvidence?.commit).toEqual(request.executionEvidenceCommit!);
  });
  expect(recovered).toBe(true);
  expect(consumed).toBe(1);
  expect(requests.slice(start).map(r => r.method)).toEqual(["GET", "GET"]);
  expect(requests.filter(r => r.method === "POST" && r.path === `/runs/${request.applyRun.id}`).length).toBe(1);
  expect((await fresh.store.read(request.stateScope!.stateRef))?.generation).toBe(1);
  expect((await readFile(EFFECTS, "utf8")).trim().split("\n").length).toBe(1);
  for (const path of Object.keys(before)) expect(await readFile(path, "utf8")).not.toContain("raw-job-canary");
});

test("legitimate pre-POST epoch takeover survives immutable custody and old epochs cannot adopt", async () => {
  const request = await job("epoch");
  const backing = createFileOpenTofuStateArtifactStore(join(ROOT, "epoch-artifacts"), stateCrypto());
  let preparationInterruption = true;
  const node = makeNode({ ...backing,
    commitApplyDispatchCustody: async record => { await backing.commitApplyDispatchCustody!(record); if (preparationInterruption) { preparationInterruption = false; throw new Error("fixture stops before POST"); } },
    commit: async () => { throw new Error("fixture stops before Node result persistence"); },
  });
  await expect(node.adapter.apply(request)).rejects.toThrow();
  const binding = `sha256:${require("node:crypto").createHash("sha256").update(JSON.stringify({ kind: "local-http-v2", endpoint: proxy.url.href })).digest("hex")}`;
  const input = { runId: request.applyRun.id, stateScope: request.stateScope!, runnerBindingDigest: binding };
  const old = await backing.readApplyDispatchCustody?.(input);
  expect(old?.reservation.epoch).toBe(1);
  const before = requests.filter(r => r.method === "POST" && r.path === `/runs/${request.applyRun.id}`).length;
  await expect(withCommittedLocalApplyRecovery(node.adapter, input, async () => { throw new Error("not dispatched"); })).rejects.toThrow();
  expect(requests.filter(r => r.method === "POST" && r.path === `/runs/${request.applyRun.id}`).length).toBe(before);
  await expect(node.adapter.apply(request)).rejects.toThrow("fixture stops before Node result persistence");
  const current = await backing.readApplyDispatchCustody?.(input);
  expect(current?.reservation.epoch).toBe(2);
  const stale = await fetch(new URL(`/runs/${request.applyRun.id}/completion`, runner.url), { headers: { "x-takosumi-mutation-action": "apply", "x-takosumi-mutation-digest": old!.requestDigest, "x-takosumi-preparation-attempt": old!.reservation.attemptId, "x-takosumi-preparation-epoch": "1" } });
  expect(stale.status).toBe(409);
  const fresh = makeNode(backing);
  expect(await withCommittedLocalApplyRecovery(fresh.adapter, input, async () => {})).toBe(true);
  expect((await backing.read(request.stateScope!.stateRef))?.createdByRunId).toBe(request.applyRun.id);
  expect(requests.filter(r => r.method === "POST" && r.path === `/runs/${request.applyRun.id}`).length).toBe(1);
});

test("normal same-process completed-response loss keeps one provider dispatch", async () => {
  const request = await job("same_process");
  loseCompletedAck = true;
  const node = makeNode(createFileOpenTofuStateArtifactStore(join(ROOT, "normal-artifacts"), stateCrypto()));
  const result = await node.adapter.apply(request);
  expect(result.executionEvidence?.runId).toBe(request.applyRun.id);
  expect((await node.store.read(request.stateScope!.stateRef))?.generation).toBe(1);
  expect(requests.filter(r => r.method === "POST" && r.path === `/runs/${request.applyRun.id}`).length).toBe(1);
});

afterAll(async () => {
  await writeFile(RELEASE, "release");
  await upstream?.then(response => response.arrayBuffer()).catch(() => {});
  proxy.stop(true); runner.stop(true); foreign.stop(true);
  await ownership.close();
});
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
