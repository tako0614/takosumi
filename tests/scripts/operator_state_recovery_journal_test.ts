import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chown, chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stableStringify } from "../../core/adapters/source/digest.ts";
import {
  openOperatorStateRecoveryJournal,
  type OpenOperatorStateRecoveryJournal,
  type OperatorRecoveryJournalStep,
} from "../../scripts/lib/operator-state-recovery-journal.ts";
import type {
  OperatorRecoveryJournalIntent,
  OperatorRecoveryJournalStaged,
} from "../../deploy/platform/operator_state_recovery.ts";

const BASE = existsSync("/root/hdd/takos-dev/tmp") ? "/root/hdd/takos-dev/tmp" : tmpdir();
const SOURCE = fileURLToPath(new URL("../../", import.meta.url));
const DIGEST = `sha256:${"a".repeat(64)}` as const;
const CUSTODY = `sha256:${"b".repeat(64)}` as const;
const REQUEST = `sha256:${"c".repeat(64)}` as const;
const roots: string[] = [];
const journals: OpenOperatorStateRecoveryJournal[] = [];

afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(BASE, "operator-recovery-journal-test-"));
  roots.push(root);
  const directory = join(root, "journal");
  await mkdir(directory, { mode: 0o700 });
  const open = async (fault?: (step: OperatorRecoveryJournalStep) => void | Promise<void>) => {
    const journal = await openOperatorStateRecoveryJournal({
      directory, sourceCheckouts: [SOURCE], testOnlyFault: fault,
    });
    journals.push(journal);
    return journal;
  };
  return { root, directory, open };
}

function intent(overrides: Partial<OperatorRecoveryJournalIntent> = {}): OperatorRecoveryJournalIntent {
  return {
    format: "takosumi.operator-source-recovery-journal@v1",
    workspaceId: "ws_1", capsuleId: "cap_1", environment: "production",
    failedApplyRunId: "apply_1", recoveryRunId: "recovery_1",
    plaintextSha256: DIGEST, custodyEvidenceDigest: CUSTODY,
    actorId: "operator_1", timestamp: "2026-09-30T00:00:00.000Z",
    requestDigest: REQUEST, ...overrides,
  };
}
function staged(value = intent(), artifactHandle = "opaque-handle-1"): OperatorRecoveryJournalStaged {
  return { intent: value, artifactHandle };
}
async function slotPath(directory: string, slot: "intent" | "staged"): Promise<string> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(`.${slot}.json`));
  expect(names).toHaveLength(1);
  return join(directory, names[0]!);
}
async function refuses(action: () => Promise<unknown>) {
  try { await action(); throw new Error("unexpected success"); }
  catch (error) { expect((error as Error).message).toBe("operator SOURCE recovery journal refused; reconcile private evidence"); }
}
function barrier() {
  let entered!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => { entered = resolve; }),
    released: new Promise<void>((resolve) => { release = resolve; }),
    signal: () => entered(),
    release: () => release(),
  };
}
async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("journal barrier timed out")), 10_000);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

test("durable exact retries retain detached records and reject every identity change", async () => {
  const f = await fixture();
  const journal = await f.open();
  const first = intent();
  const saved = await journal.putIntentIfAbsent(first);
  expect(saved).toEqual(first);
  expect(saved).not.toBe(first);
  expect(await journal.putIntentIfAbsent(first)).toEqual(first);
  const second = staged(first);
  expect(await journal.putStagedIfAbsent(second)).toEqual(second);
  expect(await journal.putStagedIfAbsent(second)).toEqual(second);
  expect(await journal.read(first.failedApplyRunId)).toEqual({ intent: first, staged: second });
  for (const change of [
    { recoveryRunId: "new-run" }, { actorId: "new-actor" },
    { timestamp: "2026-09-30T00:00:01.000Z" }, { custodyEvidenceDigest: DIGEST },
  ]) await refuses(() => journal.putIntentIfAbsent(intent(change)));
  await refuses(() => journal.putStagedIfAbsent(staged(first, "another-handle")));
  const intentBytes = await readFile(await slotPath(f.directory, "intent"), "utf8");
  expect(intentBytes).toBe(`${stableStringify(first)}\n`);
  expect((await readdir(f.directory)).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
});

test("input is copied before any await and cannot be changed through a retained object", async () => {
  const f = await fixture();
  const journal = await f.open();
  const supplied = { ...intent() };
  const pending = journal.putIntentIfAbsent(supplied);
  supplied.actorId = "mutated-actor";
  expect((await pending).actorId).toBe("operator_1");
  const selected = { intent: supplied, artifactHandle: "first-handle" };
  await refuses(() => journal.putStagedIfAbsent(selected));
  selected.intent = intent();
  const stagePending = journal.putStagedIfAbsent(selected);
  selected.artifactHandle = "mutated-handle";
  selected.intent.actorId = "mutated-again";
  expect((await stagePending).artifactHandle).toBe("first-handle");
});

test("two instances converge on exact concurrent writes and refuse a different winner", async () => {
  const f = await fixture();
  const a = await f.open();
  const b = await f.open();
  const first = intent();
  const exact = await Promise.allSettled([a.putIntentIfAbsent(first), b.putIntentIfAbsent(first)]);
  expect(exact).toHaveLength(2);
  for (const result of exact) if (result.status === "fulfilled") expect(result.value).toEqual(first);
  expect(await a.putIntentIfAbsent(first)).toEqual(first);
  expect(await b.putIntentIfAbsent(first)).toEqual(first);
  const stages = await Promise.allSettled([a.putStagedIfAbsent(staged(first)), b.putStagedIfAbsent(staged(first))]);
  expect(stages).toHaveLength(2);
  for (const result of stages) if (result.status === "fulfilled") expect(result.value).toEqual(staged(first));
  expect(await a.putStagedIfAbsent(staged(first))).toEqual(staged(first));
  expect(await b.putStagedIfAbsent(staged(first))).toEqual(staged(first));
  expect(await a.read(first.failedApplyRunId)).toEqual({ intent: first, staged: staged(first) });
  await refuses(() => b.putIntentIfAbsent(intent({ actorId: "other" })));
  await refuses(() => b.putStagedIfAbsent(staged(first, "other")));
});

test("concurrent different identities leave exactly one immutable intent", async () => {
  const f = await fixture();
  const a = await f.open();
  const b = await f.open();
  const choices = [intent(), intent({ recoveryRunId: "other-run" })];
  const outcomes = await Promise.allSettled([
    a.putIntentIfAbsent(choices[0]!), b.putIntentIfAbsent(choices[1]!),
  ]);
  expect(outcomes).toHaveLength(2);
  const durable = (await a.read("apply_1"))?.intent;
  expect(choices).toContainEqual(durable);
  for (const result of outcomes) if (result.status === "fulfilled") expect(result.value).toEqual(durable);
  expect(await b.putIntentIfAbsent(durable!)).toEqual(durable);
  await refuses(() => a.putIntentIfAbsent(choices.find((choice) =>
    choice.recoveryRunId !== durable?.recoveryRunId)!));
  expect((await readdir(f.directory)).filter((name) => name.endsWith(".intent.json"))).toHaveLength(1);
});

for (const challengerKind of ["same", "different"] as const) {
  test(`peer reconciles linked intent while publisher is paused; ${challengerKind} identity has exact outcome`, async () => {
    const f = await fixture();
    const gate = barrier();
    let paused = false;
    const publisher = await f.open(async (step) => {
      if (!paused && step === "intent.before-unlink") {
        paused = true;
        gate.signal();
        await gate.released;
      }
    });
    const peer = await f.open();
    const first = intent();
    const challenger = challengerKind === "same" ? first : intent({ recoveryRunId: "other-run" });
    const publishing = publisher.putIntentIfAbsent(first);
    let peerOutcome: PromiseSettledResult<OperatorRecoveryJournalIntent>;
    try {
      await bounded(gate.entered);
      peerOutcome = (await bounded(Promise.allSettled([peer.putIntentIfAbsent(challenger)])))[0]!;
    } finally { gate.release(); }
    const publisherOutcome = (await bounded(Promise.allSettled([publishing])))[0]!;
    expect(publisherOutcome.status).toBe("rejected");
    expect(peerOutcome.status).toBe(challengerKind === "same" ? "fulfilled" : "rejected");
    if (peerOutcome.status === "fulfilled") expect(peerOutcome.value).toEqual(first);
    expect(await peer.read("apply_1")).toEqual({ intent: first });
    expect(await publisher.putIntentIfAbsent(first)).toEqual(first);
    if (challengerKind === "different") await refuses(() => peer.putIntentIfAbsent(challenger));
    expect((await readFile(await slotPath(f.directory, "intent"), "utf8")))
      .toBe(`${stableStringify(first)}\n`);
  }, 20_000);
}

test("peer reconciles linked staged record while publisher is paused", async () => {
  const f = await fixture();
  const gate = barrier();
  let paused = false;
  const publisher = await f.open(async (step) => {
    if (!paused && step === "staged.before-unlink") {
      paused = true;
      gate.signal();
      await gate.released;
    }
  });
  const peer = await f.open();
  const first = intent();
  await publisher.putIntentIfAbsent(first);
  const selected = staged(first);
  const publishing = publisher.putStagedIfAbsent(selected);
  let peerOutcome: PromiseSettledResult<OperatorRecoveryJournalStaged>;
  try {
    await bounded(gate.entered);
    peerOutcome = (await bounded(Promise.allSettled([peer.putStagedIfAbsent(selected)])))[0]!;
  } finally { gate.release(); }
  const publisherOutcome = (await bounded(Promise.allSettled([publishing])))[0]!;
  expect(publisherOutcome.status).toBe("rejected");
  expect(peerOutcome.status).toBe("fulfilled");
  expect(await peer.read("apply_1")).toEqual({ intent: first, staged: selected });
  expect(await publisher.putStagedIfAbsent(selected)).toEqual(selected);
  await refuses(() => peer.putStagedIfAbsent(staged(first, "different-handle")));
}, 20_000);

for (const seam of ["intent.before-file-sync", "intent.after-file-sync",
  "intent.before-link", "intent.after-link", "intent.before-dir-sync",
  "intent.after-dir-sync", "intent.before-unlink", "intent.after-unlink",
  "intent.before-readback"] as const) {
  test(`intent failure ${seam} preserves or reconciles exact identity`, async () => {
    const f = await fixture();
    let fired = false;
    const damaged = await f.open((step) => {
      if (!fired && step === seam) { fired = true; throw new Error("private injected cause"); }
    });
    await refuses(() => damaged.putIntentIfAbsent(intent()));
    expect(fired).toBe(true);
    const healthy = await f.open();
    if (seam === "intent.before-file-sync" || seam === "intent.after-file-sync" ||
      seam === "intent.before-link") {
      await refuses(() => healthy.read("apply_1"));
      await refuses(() => healthy.putIntentIfAbsent(intent({ recoveryRunId: "new-id" })));
    } else {
      expect(await healthy.read("apply_1")).toEqual({ intent: intent() });
      expect(await healthy.putIntentIfAbsent(intent())).toEqual(intent());
    }
  });
}

for (const seam of ["staged.before-file-sync", "staged.after-file-sync",
  "staged.before-link", "staged.after-link", "staged.before-dir-sync",
  "staged.after-dir-sync", "staged.before-unlink", "staged.after-unlink",
  "staged.before-readback"] as const) {
  test(`staged failure ${seam} preserves intent and exact retry`, async () => {
    const f = await fixture();
    const journal = await f.open();
    await journal.putIntentIfAbsent(intent());
    let fired = false;
    const damaged = await f.open((step) => {
      if (!fired && step === seam) { fired = true; throw new Error("private injected cause"); }
    });
    await refuses(() => damaged.putStagedIfAbsent(staged()));
    expect(fired).toBe(true);
    const healthy = await f.open();
    const observed = await healthy.read("apply_1");
    expect(observed?.intent).toEqual(intent());
    if (seam === "staged.before-file-sync" || seam === "staged.after-file-sync" ||
      seam === "staged.before-link") {
      expect(observed?.staged).toBeUndefined();
    } else {
      expect(observed?.staged).toEqual(staged());
    }
    expect(await healthy.putStagedIfAbsent(staged())).toEqual(staged());
  });
}

test("staged-only final and different intent cannot acquire authority", async () => {
  const f = await fixture();
  const journal = await f.open();
  await journal.putIntentIfAbsent(intent());
  await refuses(() => journal.putStagedIfAbsent(staged(intent({ actorId: "other" }))));
  await journal.putStagedIfAbsent(staged());
  await rm(await slotPath(f.directory, "intent"));
  await refuses(() => journal.read("apply_1"));
  await refuses(() => journal.putIntentIfAbsent(intent()));
  await refuses(() => journal.putStagedIfAbsent(staged()));
});

test("unknown temp or extra hardlink makes a linked final ambiguous", async () => {
  const f = await fixture();
  let fired = false;
  const damaged = await f.open((step) => {
    if (!fired && step === "intent.before-unlink") { fired = true; throw new Error("crash after link"); }
  });
  await refuses(() => damaged.putIntentIfAbsent(intent()));
  expect(fired).toBe(true);
  const temp = (await readdir(f.directory)).find((name) => name.endsWith(".tmp"))!;
  const unknown = temp.replace(/[0-9a-f]{48}\.tmp$/u, `${"0".repeat(48)}.tmp`);
  await writeFile(join(f.directory, unknown), "unrelated", { mode: 0o600 });
  const healthy = await f.open();
  await refuses(() => healthy.read("apply_1"));
  await rm(join(f.directory, unknown));
  expect(await healthy.read("apply_1")).toEqual({ intent: intent() });
  expect(await healthy.putIntentIfAbsent(intent())).toEqual(intent());
  const final = await slotPath(f.directory, "intent");
  await link(final, join(f.directory, "extra-link"));
  await refuses(() => healthy.read("apply_1"));
});

const corruptions = [
  Buffer.from("{\"format\":\"x\",\"format\":\"y\"}\n"),
  Buffer.from([0xff, 0x0a]),
  Buffer.from(`${stableStringify(intent())} \n`),
  Buffer.from(`${stableStringify({ ...intent(), extra: "x" })}\n`),
  Buffer.alloc(64 * 1024 + 1, 0x20),
  Buffer.from(`${stableStringify(intent({ failedApplyRunId: "wrong" }))}\n`),
];
for (const [index, bytes] of corruptions.entries()) {
  test(`strict canonical UTF-8 and closed schema reject altered durable file ${index}`, async () => {
    const f = await fixture();
    const journal = await f.open();
    await journal.putIntentIfAbsent(intent());
    await writeFile(await slotPath(f.directory, "intent"), bytes);
    await refuses(() => journal.read("apply_1"));
  });
}

test("mode, symlink, hardlink, directory rotation and source paths fail closed", async () => {
  const f = await fixture();
  const journal = await f.open();
  await journal.putIntentIfAbsent(intent());
  const path = await slotPath(f.directory, "intent");
  await chmod(path, 0o644);
  await refuses(() => journal.read("apply_1"));
  await chmod(path, 0o600);
  await link(path, join(f.directory, "unexpected-hardlink"));
  await refuses(() => journal.read("apply_1"));
  await rm(join(f.directory, "unexpected-hardlink"));
  const body = await readFile(path);
  await rm(path);
  const replacement = join(f.directory, "body-file");
  await writeFile(replacement, body, { mode: 0o600 });
  await symlink(replacement, path);
  await refuses(() => journal.read("apply_1"));
  await rm(path);
  await writeFile(path, body, { mode: 0o600 });
  const hidden = join(f.root, "old-journal");
  await rename(f.directory, hidden);
  await mkdir(f.directory, { mode: 0o700 });
  await refuses(() => journal.read("apply_1"));
  await refuses(() => openOperatorStateRecoveryJournal({ directory: SOURCE, sourceCheckouts: [SOURCE] }));
  const linked = join(f.root, "linked");
  await symlink(hidden, linked);
  await refuses(() => openOperatorStateRecoveryJournal({ directory: linked, sourceCheckouts: [SOURCE] }));
});

test("owner mismatch is refused where the test process can change fixture ownership", async () => {
  const f = await fixture();
  const journal = await f.open();
  await journal.putIntentIfAbsent(intent());
  const path = await slotPath(f.directory, "intent");
  const uid = process.getuid?.();
  if (uid === undefined) return;
  try { await chown(path, uid + 1, process.getgid?.() ?? 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EPERM") return;
    throw error;
  }
  await refuses(() => journal.read("apply_1"));
});

test("a Git marker in a parent refuses a directory outside declared source roots", async () => {
  const f = await fixture();
  await writeFile(join(f.root, ".git"), "gitdir: elsewhere\n", { mode: 0o600 });
  await refuses(() => f.open());
});
