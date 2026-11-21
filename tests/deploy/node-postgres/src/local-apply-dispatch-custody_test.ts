import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { createFileLocalApplyDispatchCustodyStore, type LocalApplyDispatchCustody } from "../../../../deploy/node-postgres/src/local-apply-dispatch-custody.ts";

const digest = `sha256:${"a".repeat(64)}` as const;
function record(epoch = 1): LocalApplyDispatchCustody {
  return { runId: "apply_custody_fixture", runnerBindingDigest: digest, requestDigest: digest,
    stateScope: { workspaceId: "workspace_fixture", subject: { kind: "capsule", id: "capsule_fixture" }, environment: "integration", generation: 1, stateRef: "opaque-state-fixture" },
    reservation: { kind: "v2", attemptId: `00000000-0000-0000-0000-${String(epoch).padStart(12, "0")}`, epoch },
    identity: { runId: "apply_custody_fixture", planRunId: "plan_custody_fixture", runnerProfileId: "opentofu-default", executorId: "opentofu",
      authority: { controllerArtifact: { digest, immutable: true }, runnerArtifact: { digest, immutable: true }, executorArtifact: { digest, immutable: true } },
      plan: { digest, artifactDigest: digest }, commit: { stateVersionId: "state_fixture", outputId: "out_fixture" } } };
}
async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]))).flat();
}
const crypto = () => new PartitionedSecretBoundaryCrypto({ globalPassphrase: "local-dispatch-custody-synthetic-test-passphrase" });

test("dispatch custody is encrypted, immutable per epoch, and selects only the highest saved epoch", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-dispatch-custody-"));
  try {
    const store = createFileLocalApplyDispatchCustodyStore(root, crypto());
    expect(await store.readApplyDispatchCustody(record())).toBeUndefined();
    await store.commitApplyDispatchCustody(record());
    await store.commitApplyDispatchCustody(record());
    await store.commitApplyDispatchCustody(record(3)); // epoch2 may have failed before a POST
    expect((await store.readApplyDispatchCustody(record()))?.reservation.epoch).toBe(3);
    expect((await createFileLocalApplyDispatchCustodyStore(root, crypto()).readApplyDispatchCustody(record()))?.identity).toEqual(record().identity);
    const occupied = await files(root);
    expect(occupied.length).toBe(2);
    for (const path of occupied) {
      const text = await readFile(path, "utf8");
      expect(text).not.toContain("apply_custody_fixture");
      expect(text).not.toContain("requestDigest");
      expect(text).not.toContain("attemptId");
      expect(Object.keys(JSON.parse(text)).sort()).toEqual(["ciphertextBase64", "epoch", "kind"]);
    }
    await expect(store.commitApplyDispatchCustody({ ...record(3), requestDigest: `sha256:${"b".repeat(64)}` })).rejects.toThrow();
    await expect(store.commitApplyDispatchCustody(record(65))).rejects.toThrow();
    expect(await store.readApplyDispatchCustody({ ...record(), runnerBindingDigest: `sha256:${"b".repeat(64)}` })).toBeUndefined();
    expect(await store.readApplyDispatchCustody({ ...record(), runId: "another-run" })).toBeUndefined();
    await expect(store.commitApplyDispatchCustody({ ...record(), credentials: { env: { SYNTHETIC_SECRET: "not-persisted" } } } as unknown as LocalApplyDispatchCustody)).rejects.toThrow();
    expect((await files(root)).length).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dispatch custody never falls back past a corrupt, oversized or linked newest epoch", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-dispatch-refusal-"));
  try {
    const store = createFileLocalApplyDispatchCustodyStore(root, crypto());
    await store.commitApplyDispatchCustody(record());
    await store.commitApplyDispatchCustody(record(2));
    const latest = (await files(root)).find(path => path.endsWith("/2.json"))!;
    const older = (await files(root)).find(path => path.endsWith("/1.json"))!;
    const original = await readFile(latest);
    const envelope = JSON.parse(original.toString());
    envelope.ciphertextBase64 = JSON.parse(await readFile(older, "utf8")).ciphertextBase64;
    await writeFile(latest, JSON.stringify(envelope));
    await expect(store.readApplyDispatchCustody(record())).rejects.toThrow();
    await writeFile(latest, "x".repeat(16 * 1024 + 1));
    await expect(store.readApplyDispatchCustody(record())).rejects.toThrow();
    await rm(latest);
    await symlink(older, latest);
    await expect(store.readApplyDispatchCustody(record())).rejects.toThrow();
    await rm(latest);
    await writeFile(latest, original);
    expect((await store.readApplyDispatchCustody(record()))?.reservation.epoch).toBe(2);
    await expect(createFileLocalApplyDispatchCustodyStore(root, new PartitionedSecretBoundaryCrypto({ globalPassphrase: "different-synthetic-custody-key-32-bytes" })).readApplyDispatchCustody(record())).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
