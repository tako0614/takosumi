import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOpenTofuOutputProof } from "../proofs/opentofu-output-proof.ts";

const FIXTURE_INPUT = "fixtures/opentofu-output-proof/proof-input.json";

test("fixture proof imports explicitly mapped ordinary OpenTofu outputs", async () => {
  const proof = await runOpenTofuOutputProof({
    inputPath: FIXTURE_INPUT,
    now: () => "2026-06-02T00:00:00.000Z",
  });

  expect(proof.kind).toBe("takosumi.opentofu-output-proof@v1");
  expect(proof.status).toBe("passed");
  expect(proof.live).toBe(false);
  expect(proof.evidence.outputsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(proof.evidence.applyRunOutputsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(proof.evidence.outputDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(proof.evidence.applyAuditEventCount).toBeGreaterThan(0);
  expect(proof.evidence.stateLockStatus).toBe("recorded");
  expect(proof.planRun.status).toBe("succeeded");
  expect(proof.applyRun.status).toBe("succeeded");
  expect(proof.capsule.currentStateVersionId).toBe(proof.stateVersion.id);
  expect(proof.stateVersion.createdByRunId).toBe(proof.applyRun.id);
  expect(proof.output.stateGeneration).toBe(proof.stateVersion.generation);
  expect(proof.output.publicOutputs).toEqual({
    site_origin: "https://demo.fixture.example",
    management_origin: "https://demo.fixture.example/admin",
    health_probe: "https://demo.fixture.example/health",
  });
});

test("live proof rejects fixture refs", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-opentofu-proof-"));
  try {
    const raw = JSON.parse(await readFile(FIXTURE_INPUT, "utf8"));
    raw.live = true;
    const inputPath = join(tempDir, "proof-input.json");
    await writeFile(inputPath, JSON.stringify(raw, null, 2));

    await expect(runOpenTofuOutputProof({ inputPath })).rejects.toThrow(
      "operator.opentofuApplyRef must use a private artifact ref",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
