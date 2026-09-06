import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Step = {
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};

test("native Runner CI hands off one attested image without publication authority", () => {
  const workflow = Bun.YAML.parse(readFileSync(
    join(import.meta.dir, "../../.github/workflows/runner-image-proof.yml"),
    "utf8",
  )) as {
    on: Record<string, unknown>;
    jobs: Record<string, {
      "runs-on": string;
      permissions: Record<string, string>;
      steps: Step[];
    }>;
  };
  const job = workflow.jobs["prove-runner-docker"]!;
  const candidateIndex = job.steps.findIndex((step) => step.id === "candidate");
  expect(candidateIndex).toBeGreaterThanOrEqual(0);
  expect(job["runs-on"]).toBe("ubuntu-latest");
  expect(job.permissions).toEqual({
    contents: "read",
    "id-token": "write",
    attestations: "write",
  });
  expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);

  const candidate = job.steps[candidateIndex]!;
  expect(candidate.run).toContain("bun scripts/runner-image-native-candidate.ts");
  expect(candidate.run).toContain('--output-dir "$RUNNER_TEMP/runner-native-candidate"');
  expect(existsSync(join(import.meta.dir, "../../scripts/runner-image-native-candidate.ts"))).toBe(true);

  const attestIndex = job.steps.findIndex((step) => step.id === "attest");
  expect(attestIndex).toBeGreaterThan(candidateIndex);
  const attest = job.steps[attestIndex]!;
  expect(attest.uses).toMatch(/^actions\/attest@[0-9a-f]{40}$/u);
  expect(String(attest.with?.["subject-path"]).trim().split("\n")).toEqual([
    "${{ runner.temp }}/runner-native-candidate/runner-image.tar",
    "${{ runner.temp }}/runner-native-candidate/candidate.json",
  ]);
  expect(attest.with?.["push-to-registry"]).toBe(false);

  const bundleIndex = job.steps.findIndex((step) => step.id === "bundle");
  expect(bundleIndex).toBeGreaterThan(attestIndex);
  expect(job.steps[bundleIndex]!.env?.ATTESTATION_BUNDLE).toBe(
    "${{ steps.attest.outputs.bundle-path }}",
  );
  expect(job.steps[bundleIndex]!.run).toContain(
    '"$RUNNER_TEMP/runner-native-candidate/attestation.jsonl"',
  );
  const uploadIndex = job.steps.findIndex((step) => step.id === "upload");
  expect(uploadIndex).toBeGreaterThan(bundleIndex);
  const upload = job.steps[uploadIndex]!;
  expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/u);
  expect(String(upload.with?.path).trim().split("\n")).toEqual([
    "${{ runner.temp }}/runner-native-candidate/runner-image.tar",
    "${{ runner.temp }}/runner-native-candidate/candidate.json",
    "${{ runner.temp }}/runner-native-candidate/attestation.jsonl",
  ]);
  expect(upload.with?.["if-no-files-found"]).toBe("error");
  expect(upload.with?.overwrite).toBe(false);
  expect(Number.isInteger(upload.with?.["retention-days"])).toBe(true);
  expect(Number(upload.with?.["retention-days"])).toBeGreaterThan(0);

  const docker = job.steps.find((step) => step.uses?.startsWith("docker/setup-docker-action@"));
  expect(docker?.with?.version).toMatch(/^v\d+\.\d+\.\d+$/u);
  expect(docker?.with?.["set-host"]).toBe(true);
  expect(JSON.parse(String(docker?.with?.["daemon-config"]))).toEqual({
    features: { "containerd-snapshotter": true },
  });
  const bun = job.steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
  expect(bun?.with?.["bun-version"]).toMatch(/^\d+\.\d+\.\d+$/u);
  const cosign = job.steps.find((step) => step.uses?.startsWith("sigstore/cosign-installer@"));
  expect(cosign?.with?.["cosign-release"]).toMatch(/^v\d+\.\d+\.\d+$/u);
  for (const step of job.steps) {
    if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/u);
  }
  const commands = job.steps.map((step) => step.run ?? "").join("\n");
  expect(commands).not.toMatch(/\bwrangler\b|\bdocker\s+push\b|bun run deploy/u);
  expect(JSON.stringify(job)).not.toMatch(/secrets\.|CLOUDFLARE_API_TOKEN|APPARMOR_UNCONFINED/u);
});
