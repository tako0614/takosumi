import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOpenTofuOutputSnapshotProof } from "../proofs/opentofu-output-snapshot.ts";

const FIXTURE_INPUT =
  "fixtures/opentofu-output-snapshot-proof/proof-input.json";

test("fixture proof imports OpenTofu outputs and records OutputSnapshot projection", async () => {
  const proof = await runOpenTofuOutputSnapshotProof({
    inputPath: FIXTURE_INPUT,
    now: () => "2026-06-02T00:00:00.000Z",
  });

  expect(proof.kind).toBe("takosumi.opentofu-output-snapshot-proof@v1");
  expect(proof.status).toBe("passed");
  expect(proof.live).toBe(false);
  expect(proof.evidence.outputsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(proof.evidence.applyRunOutputsDigest).toBe(
    proof.evidence.outputSnapshotDigest,
  );
  expect(proof.evidence.applyAuditEventCount).toBeGreaterThan(0);
  expect(proof.evidence.stateLockStatus).toBe("recorded");
  expect(proof.planRun.status).toBe("succeeded");
  expect(proof.applyRun.status).toBe("succeeded");
  expect(proof.deployment.outputs).toEqual([
    {
      name: "takosumi_launch_url",
      kind: "url",
      value: "https://demo.fixture.example",
      sensitive: false,
    },
    {
      name: "takosumi_admin_url",
      kind: "url",
      value: "https://demo.fixture.example/admin",
      sensitive: false,
    },
    {
      name: "health_url",
      kind: "url",
      value: "https://demo.fixture.example/health",
      sensitive: false,
    },
  ]);
});

test("live proof rejects fixture refs", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-opentofu-proof-"));
  try {
    const raw = JSON.parse(await readFile(FIXTURE_INPUT, "utf8"));
    raw.live = true;
    const inputPath = join(tempDir, "proof-input.json");
    await writeFile(inputPath, JSON.stringify(raw, null, 2));

    await expect(
      runOpenTofuOutputSnapshotProof({ inputPath }),
    ).rejects.toThrow(
      "operator.opentofuApplyRef must use a private artifact ref",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
