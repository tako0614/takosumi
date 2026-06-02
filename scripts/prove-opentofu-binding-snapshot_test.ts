import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOpenTofuBindingSnapshotProof } from "./prove-opentofu-binding-snapshot.ts";

const FIXTURE_INPUT =
  "fixtures/opentofu-binding-snapshot-proof/proof-input.json";

test("fixture proof imports OpenTofu outputs and records Deployment binding snapshot", async () => {
  const proof = await runOpenTofuBindingSnapshotProof({
    inputPath: FIXTURE_INPUT,
    now: () => "2026-06-02T00:00:00.000Z",
  });

  expect(proof.kind).toBe("takosumi.opentofu-binding-snapshot-proof@v1");
  expect(proof.status).toBe("passed");
  expect(proof.live).toBe(false);
  expect(proof.evidence.outputsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(proof.evidence.dryRunBindingsDigest).toBe(
    proof.evidence.deploymentBindingsDigest,
  );
  expect(proof.deployment.bindingsSnapshot).toHaveLength(2);
  expect(proof.deployment.outputs.public?.oidc).toEqual({
    issuerUrl: "https://accounts.fixture.example",
    clientId: "fixture-client",
  });
  expect(proof.deployment.outputs.public?.assets).toEqual({
    bucket: "fixture-assets",
    endpoint: "https://r2.fixture.example",
  });
});

test("live proof rejects fixture refs", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "takosumi-opentofu-proof-"));
  try {
    const raw = JSON.parse(await readFile(FIXTURE_INPUT, "utf8"));
    raw.live = true;
    const inputPath = join(tempDir, "proof-input.json");
    await writeFile(inputPath, JSON.stringify(raw, null, 2));

    await expect(runOpenTofuBindingSnapshotProof({ inputPath })).rejects
      .toThrow("operator.opentofuApplyRef must use a private artifact ref");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
