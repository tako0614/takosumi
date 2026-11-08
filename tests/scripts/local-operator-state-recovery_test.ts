import { expect, spyOn, test } from "bun:test";
import { chmod, link, mkdtemp, readFile, rename, rm, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ApplyRun } from "@takosumi/internal/deploy-control-api";
import { checkLocalStateRecoveryApproval, commitApprovedLocalStateRecovery } from "../../scripts/lib/local-operator-state-recovery.ts";
import { createLocalOperatorRecoveryFixture as fixture, OPERATOR_RECOVERY_TEST_SOURCE_ROOT as ROOT } from "../helpers/deploy-control/local_operator_recovery_fixture.ts";

async function withFixture(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture();
  try { await run(f); } finally { await rm(f.root, { recursive: true, force: true }); }
}

test("local approval uses actual encrypted readback and Core commit without staging or relabelling Apply", async () => {
  await withFixture(async f => {
    const stage = spyOn(f.artifactStore, "commitRecovery");
    const result = await commitApprovedLocalStateRecovery(f.input);
    expect(result.status).toBe("committed");
    if (result.status === "conflict") throw Error("unexpected fixture conflict");
    expect(result.run.type).toBe("state_recovery");
    expect(result.run.createdBy).toBe(`local-unix-account:${process.getuid!()}`);
    expect(result.run.createdAt).toBe(f.profile.commandTimestamp);
    expect(result.stateVersion.digest).toBe(f.staged.artifact.plaintextSha256);
    expect(result.capsule.status).toBe("error");
    expect(result.capsule.currentOutputId).toBeUndefined();
    expect((await f.store.getApplyRun(f.failed.id))?.status).toBe("failed");
    expect(result.run.executionEvidence).toBeUndefined();
    expect(await f.store.getCapsuleRuntimeSafety(f.seeded.capsule.id)).toMatchObject({ phase: "unknown", runId: f.failed.id });
    expect(stage).not.toHaveBeenCalled();
    stage.mockRestore();
  });
});

test("unknown Core commit ACK retries the same approved identity and fixed timestamp", async () => {
  await withFixture(async f => {
    const commit = f.store.commitRecoveredState.bind(f.store);
    let lose = true;
    f.store.commitRecoveredState = async input => { const result = await commit(input); if (lose) { lose = false; throw Error("synthetic lost ACK"); } return result; };
    await expect(commitApprovedLocalStateRecovery(f.input)).rejects.toThrow("synthetic lost ACK");
    const replayed = await commitApprovedLocalStateRecovery(f.input);
    expect(replayed.status).toBe("replayed");
    if (replayed.status === "conflict") throw Error("unexpected conflict");
    expect(replayed.run.id).toBe(f.profile.recoveryRunId);
    expect(replayed.run.createdAt).toBe(f.profile.commandTimestamp);
    expect((await f.store.getCapsule(f.seeded.capsule.id))?.currentStateGeneration).toBe(1);
  });
});

test("wrong approval identities, target, scope, artifact and expiry cannot commit", async () => {
  await withFixture(async f => {
    const commit = spyOn(f.store, "commitRecoveredState");
    const mutations: Record<string, unknown>[] = [
      { format: "other" }, { purpose: "apply" }, { caseId: "other" }, { approvedOperatorId: `local-unix-account:${process.getuid!() + 1}` },
      { selectedTargetId: "other" }, { workspaceId: "other" }, { capsuleId: "other" }, { environment: "other" },
      { failedApplyRunId: "other" }, { recoveryRunId: "other" }, { artifactHandle: "https://not-an-artifact" },
      { plaintextSha256: `sha256:${"b".repeat(64)}` }, { encryptedDigest: `sha256:${"d".repeat(64)}` },
      { evidenceDigest: `sha256:${"e".repeat(64)}` }, { commandTimestamp: new Date(Date.now() + 60_000).toISOString() },
      { expiresAt: new Date(Date.now() - 1000).toISOString() }, { commandTimestamp: "2026-02-30" }, { extra: "not-authority" },
    ];
    for (const mutation of mutations) {
      await f.write({ ...f.profile, ...mutation });
      await expect(commitApprovedLocalStateRecovery(f.input)).rejects.toThrow();
      expect(commit).not.toHaveBeenCalled();
      expect((await f.store.getCapsule(f.seeded.capsule.id))?.currentStateGeneration).toBe(0);
    }
    commit.mockRestore();
  });
});

test("fixed approval timestamp cannot predate the observed failed Apply termination", async () => {
  await withFixture(async f => {
    await f.store.putApplyRun({ ...f.failed, finishedAt: Date.parse(f.profile.commandTimestamp) + 500 });
    await expect(commitApprovedLocalStateRecovery(f.input)).rejects.toThrow();
    expect((await f.store.getCapsule(f.seeded.capsule.id))?.currentStateGeneration).toBe(0);
  });
});

test("missing or malformed failed terminal evidence never permits local recovery", async () => {
  await withFixture(async f => {
    for (const finishedAt of [undefined, "not-a-time", Number.NaN]) {
      await f.store.putApplyRun({ ...f.failed, finishedAt } as unknown as ApplyRun);
      await expect(commitApprovedLocalStateRecovery(f.input)).rejects.toThrow();
      expect((await f.store.getCapsule(f.seeded.capsule.id))?.currentStateGeneration).toBe(0);
    }
    // Strict historical ISO terminal timestamps are real evidence too.
    await f.store.putApplyRun({ ...f.failed, finishedAt: new Date(3).toISOString() } as unknown as ApplyRun);
    expect((await commitApprovedLocalStateRecovery(f.input)).status).toBe("committed");
  });
});

test("approval revocation during actual artifact verification denies before Core commit", async () => {
  await withFixture(async f => {
    const verify = f.input.verifier.verify.bind(f.input.verifier);
    f.input.verifier.verify = async scope => { const artifact = await verify(scope); await f.write({ ...f.profile, selectedTargetId: "revoked" }); return artifact; };
    const commit = spyOn(f.store, "commitRecoveredState");
    await expect(commitApprovedLocalStateRecovery(f.input)).rejects.toThrow("approval or custody");
    expect(commit).not.toHaveBeenCalled();
    commit.mockRestore();
  });
});

test("private approval custody rejects aliases, unsafe ancestors, modes, oversized and in-source files", async () => {
  await withFixture(async f => {
    await chmod(f.path, 0o400);
    await checkLocalStateRecoveryApproval(f.input);
    await chmod(f.path, 0o644);
    await expect(checkLocalStateRecoveryApproval(f.input)).rejects.toThrow();
    await chmod(f.path, 0o600);
    const alias = join(f.input.approvalDirectory, "alias");
    await link(f.path, alias);
    await expect(checkLocalStateRecoveryApproval(f.input)).rejects.toThrow();
    await unlink(alias);
    const saved = join(f.input.approvalDirectory, "saved");
    await rename(f.path, saved); await symlink(saved, f.path);
    await expect(checkLocalStateRecoveryApproval(f.input)).rejects.toThrow();
    await unlink(f.path); await rename(saved, f.path);
    await chmod(f.root, 0o777);
    await expect(checkLocalStateRecoveryApproval(f.input)).rejects.toThrow();
    await chmod(f.root, 0o700);
    await expect(checkLocalStateRecoveryApproval({ ...f.input, sourceRoots: [f.root] })).rejects.toThrow();
    await expect(checkLocalStateRecoveryApproval({ ...f.input, caseId: "../case_one" })).rejects.toThrow();
    await f.write({ ...f.profile, padding: "x".repeat(20_000) });
    await expect(checkLocalStateRecoveryApproval(f.input)).rejects.toThrow();
    expect((await f.store.getCapsule(f.seeded.capsule.id))?.currentStateGeneration).toBe(0);
  });
});

test("standalone help/import never starts server and unapproved invocation never opens configured PG", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "scripts/operator-state-recovery.ts", "--help"], {
    cwd: ROOT, env: { PATH: process.env.PATH, TAKOSUMI_ACCOUNTS_MAIN: "1" }, stdout: "pipe", stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toContain("--case");
  expect(await new Response(child.stderr).text()).toBe("");
  const refused = Bun.spawn([process.execPath, "--no-env-file", "scripts/operator-state-recovery.ts", "--case", "missing"], {
    cwd: ROOT, env: { PATH: process.env.PATH, TAKOSUMI_OPERATOR_STATE_RECOVERY_APPROVAL_DIR: "/nonexistent-operator-approval",
      TAKOSUMI_OPERATOR_STATE_RECOVERY_TARGET_ID: "fixture", TAKOSUMI_ACCOUNTS_DATABASE_URL: "postgres://private-user:private-password@127.0.0.1:1/not-opened",
      TAKOSUMI_LOCAL_STATE_ARTIFACT_DIR: "/not-created-state-root" }, stdout: "pipe", stderr: "pipe",
  });
  expect(await refused.exited).toBe(1);
  expect(await new Response(refused.stdout).text()).toBe("");
  expect(await new Response(refused.stderr).text()).toBe("local_state_recovery_refused\n");
});

test("CLI reports connection-close failure separately from the known Core commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "operator-close-proof-"));
  const terminal = join(root, "terminal.json");
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", "tests/fixtures/local-operator-recovery-command.ts"], {
      cwd: ROOT, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, FIXTURE_TERMINAL_PATH: terminal },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1);
    expect(JSON.parse(await readFile(terminal, "utf8"))).toEqual({ closeCalls: 1, generation: 1, failedStatus: "failed" });
    expect(JSON.parse(out)).toMatchObject({ status: "connection_close_failed", recovery: { status: "committed" } });
    expect(err).toBe("local_state_recovery_connection_close_failed\n");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);

test("missing approval refuses before the PG constructor, queries or cleanup are reached", async () => {
  const root = await mkdtemp(join(tmpdir(), "operator-unapproved-proof-"));
  const terminal = join(root, "terminal.json");
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", "tests/fixtures/local-operator-recovery-unapproved.ts"], {
      cwd: ROOT, env: { PATH: process.env.PATH, FIXTURE_TERMINAL_PATH: terminal }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("local_state_recovery_refused\n");
    expect(JSON.parse(await readFile(terminal, "utf8"))).toEqual({ pools: 0, queries: 0, closes: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
