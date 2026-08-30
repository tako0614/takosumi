import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

test("OSS deploy entrypoint owns the official platform Worker without a Cloud wrapper", async () => {
  const child = Bun.spawn(["bun", "scripts/deploy.mjs", "--contract"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  const contract = JSON.parse(stdout) as {
    readonly surfaces: readonly {
      readonly surface: string;
      readonly target: string;
      readonly triggers?: readonly string[];
      readonly obligations?: Readonly<Record<string, string>>;
    }[];
  };
  expect(contract.surfaces).toEqual([
    expect.objectContaining({
      surface: "takosumi-control-d1-bridge-proof-staging",
      target: "private-evidence:takosumi-control-d1-bridge-staging",
      triggers: ["authority"],
    }),
    expect.objectContaining({
      surface: "takosumi-control-d1-bridge-proof",
      target: "private-evidence:takosumi-control-d1-bridge-production",
      triggers: ["authority"],
    }),
    expect.objectContaining({
      surface: "takosumi-control-d1-schema-staging",
      target: "cloudflare-d1:takosumi-control-staging",
      triggers: ["irreversible", "authority"],
    }),
    expect.objectContaining({
      surface: "takosumi-control-d1-schema",
      target: "cloudflare-d1:takosumi-control-production",
      triggers: ["irreversible", "authority"],
    }),
    expect.objectContaining({
      surface: "takosumi-platform-staging",
      target: "cloudflare-worker:takosumi-staging",
    }),
    expect.objectContaining({
      surface: "takosumi-platform",
      target: "cloudflare-worker:takosumi",
    }),
    expect.objectContaining({
      surface: "takosumi-runner-image",
      target: "cloudflare-container:takosumi-runner",
    }),
    expect.objectContaining({
      surface: "takosumi-website",
      target: "cloudflare-pages:takosumi-website",
    }),
    expect.objectContaining({
      surface: "takosumi-contract-package",
      target: "npm:@takosjp/takosumi-contract",
    }),
  ]);
  const runnerImage = contract.surfaces.find(
    (entry) => entry.surface === "takosumi-runner-image",
  );
  for (const surface of [
    "takosumi-control-d1-bridge-proof-staging",
    "takosumi-control-d1-bridge-proof",
  ]) {
    const proof = contract.surfaces.find((entry) => entry.surface === surface);
    expect(proof?.obligations?.provenance).toContain(
      "complete validated v5",
    );
    expect(proof?.obligations?.provenance).toContain(
      "live immutable Worker Version",
    );
    expect(proof?.obligations?.["post-conditions"]).toContain(
      "rereads the raw platform evidence",
    );
    expect(proof?.obligations?.["failure-handling"]).toContain(
      "hand-authored JSON",
    );
  }
  for (const surface of [
    "takosumi-control-d1-schema-staging",
    "takosumi-control-d1-schema",
  ]) {
    const schema = contract.surfaces.find((entry) => entry.surface === surface);
    expect(Object.keys(schema?.obligations ?? {}).sort()).toEqual([
      "failure-handling",
      "independent-review",
      "post-conditions",
      "pre-mutation-proof",
      "provenance",
      "reversal",
    ]);
    expect(schema?.obligations?.provenance).toContain(
      "official private reviewed compatibility proof",
    );
    expect(schema?.obligations?.provenance).toContain(
      "complete takosumi.platform-worker-release-plan@v5",
    );
    expect(schema?.obligations?.provenance).toContain(
      "raw platform ready-evidence path/digest",
    );
    expect(schema?.obligations?.provenance).toContain(
      "same physical account/database tuple",
    );
    expect(schema?.obligations?.provenance).toContain(
      "same secret-free token-custody digest",
    );
    expect(schema?.obligations?.provenance).toContain(
      "raw tokens never enter plans, receipts, evidence, diagnostics, or stdout",
    );
    expect(schema?.obligations?.provenance).toContain(
      "never observed-ready adoption",
    );
    expect(schema?.obligations?.["pre-mutation-proof"]).toContain(
      "proof-bound serving bridge Version",
    );
    expect(schema?.obligations?.["pre-mutation-proof"]).toContain(
      "target then plan-lock order",
    );
    expect(schema?.obligations?.["pre-mutation-proof"]).toContain(
      "same explicit durable operator-private target authority used by platform",
    );
    expect(schema?.obligations?.["pre-mutation-proof"]).toContain(
      "requires no unresolved restore checkpoint",
    );
    expect(schema?.obligations?.["pre-mutation-proof"]).toContain(
      "genuine execution receipt with distinct target and credential custody",
    );
    expect(schema?.obligations?.["pre-mutation-proof"]).toContain(
      "one canonical-path and existing-inode graph",
    );
    expect(schema?.obligations?.["pre-mutation-proof"]).toContain(
      "raw platform ready evidence",
    );
    expect(schema?.obligations?.["pre-mutation-proof"]).toContain(
      "including absent future aliases",
    );
    expect(schema?.obligations?.["failure-handling"]).toContain(
      "require official restore reconciliation",
    );
    expect(schema?.obligations?.["failure-handling"]).toContain(
      "excludes every official platform forward/restore mutation while schema can change or certify v67",
    );
    expect(schema?.obligations?.["failure-handling"]).toContain(
      "durably binds the exact schema plan/checkpoint",
    );
    expect(schema?.obligations?.["failure-handling"]).toContain(
      "permits only that plan's recover",
    );
    expect(schema?.obligations?.reversal).toContain(
      "permanently retires the exact bridge deployment plan's v66-only predecessor restore",
    );
    expect(schema?.obligations?.reversal).toContain(
      "rechecking the retained proof, live bridge Version and D1 binding",
    );
  }
  for (const surface of ["takosumi-platform-staging", "takosumi-platform"]) {
    const platform = contract.surfaces.find(
      (entry) => entry.surface === surface,
    );
    expect(platform?.obligations?.reversal).toContain(
      "rejects a durable schema-retirement marker before any Container or Worker mutation",
    );
    expect(platform?.obligations?.reversal).toContain(
      "complete plan validator binds environment, source, confirmation, checkpoint, and predecessor",
    );
    expect(platform?.obligations?.["pre-mutation-proof"]).toContain(
      "rejects a control-D1 schema-retirement marker before its first provider checkpoint",
    );
    expect(platform?.obligations?.["pre-mutation-proof"]).toContain(
      "explicit durable operator-private TAKOSUMI_PLATFORM_MUTATION_AUTHORITY_DIR",
    );
    expect(platform?.obligations?.["pre-mutation-proof"]).toContain(
      "through provider mutation and authoritative readback",
    );
    expect(platform?.obligations?.["pre-mutation-proof"]).toContain(
      "operation kind plus exact plan confirmation and checkpoint path",
    );
    expect(platform?.obligations?.["pre-mutation-proof"]).toContain(
      "device/inode/birth-time/UID/mode identity digest",
    );
    expect(platform?.obligations?.["pre-mutation-proof"]).toContain(
      "permits only exact checkpoint/provider recovery",
    );
  }
  expect(runnerImage?.triggers).toEqual(["authority", "published-identity"]);
  expect(Object.keys(runnerImage?.obligations ?? {}).sort()).toEqual([
    "failure-handling",
    "independent-review",
    "no-overwrite",
    "post-conditions",
    "provenance",
    "reversal",
  ]);

  const source = await Bun.file(resolve(root, "scripts/deploy.mjs")).text();
  expect(source).not.toContain("takosumi-cloud");
  expect(source).toContain('import("./control-d1-schema-release.ts")');
  expect(source).toContain('import("./platform-worker-release.ts")');
  expect(source).toContain('import("./runner-image-release.ts")');

  const schemaSource = await Bun.file(
    resolve(root, "scripts/control-d1-schema-release.ts"),
  ).text();
  expect(schemaSource.toLowerCase()).not.toContain("oauth");
  expect(schemaSource.toLowerCase()).not.toContain("wrangler");
  expect(schemaSource).toContain(
    "/workers/scripts/${encodeURIComponent(target.workerName)}",
  );
  expect(schemaSource).toContain("CloudflareControlD1RestDatabase");
  const platformSource = await Bun.file(
    resolve(root, "scripts/platform-worker-release.ts"),
  ).text();
  expect(
    platformSource.match(/await withPlatformTargetMutationLock\(/gu),
  ).toHaveLength(3);
  expect(
    schemaSource.match(/await withPlatformTargetMutationLock\(/gu),
  ).toHaveLength(4);
  expect(platformSource).toContain(
    "() => completeRelease(options, releasePlan!, true)",
  );
  expect(platformSource).toContain(
    "() => completeRelease(options, releasePlan!, false, head)",
  );
});

test("official bridge proof surfaces route to the strict read-only producer", async () => {
  for (const surface of [
    "takosumi-control-d1-bridge-proof-staging",
    "takosumi-control-d1-bridge-proof",
  ]) {
    const child = Bun.spawn(["bun", "scripts/deploy.mjs", surface], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(
      "control_d1_serving_compatibility_proof_action_invalid",
    );
  }
});
