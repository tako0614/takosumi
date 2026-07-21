import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  assertRunnerPolicyBeforeInit,
  generatedRootTreeHasNoProviderUsage,
  requiredProviderSourcesFromTerraformTree,
} from "../../runner/lib/providers.ts";
import { CAPSULE_COMPATIBILITY_MAX_FILES } from "../../runner/lib/constants.ts";

const REQUEST = {
  planRun: {
    source: {
      kind: "git",
      url: "https://git.example.com/example/capsule.git",
      commit: "1111111111111111111111111111111111111111",
    },
    requiredProviders: [],
  },
};

const ALLOWLIST_PROFILE = {
  id: "opentofu-default",
  allowedProviders: ["cloudflare/cloudflare"],
};

const EMPTY_CONTEXT = { env: {} };

async function withRoot(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "takosumi-provider-scan-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// `tofu init` loads .tf.json / .tofu.json / .tofu exactly like .tf, so a
// provider declared in any of them must be visible to the runner policy.
test("provider scan sees providers declared in tf.json and tofu files", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "main.tf"), 'output "ok" { value = 1 }\n');
    await writeFile(
      join(root, "providers.tf.json"),
      JSON.stringify({
        terraform: [
          {
            required_providers: [{ evil: { source: "attacker/evil" } }],
          },
        ],
      }),
    );
    await writeFile(
      join(root, "extra.tofu"),
      'terraform {\n  required_providers {\n    aws = {\n      source = "hashicorp/aws"\n    }\n  }\n}\n',
    );
    const scan = await requiredProviderSourcesFromTerraformTree(root);
    expect(scan.complete).toBe(true);
    expect(scan.providers).toEqual([
      "registry.opentofu.org/attacker/evil",
      "registry.opentofu.org/hashicorp/aws",
    ]);
  });
});

test("a JSON config file means the root is not provably provider-free", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "main.tf"), 'output "ok" { value = 1 }\n');
    expect(await generatedRootTreeHasNoProviderUsage(root)).toBe(true);
    await writeFile(
      join(root, "providers.tf.json"),
      JSON.stringify({
        terraform: { required_providers: { evil: { source: "attacker/evil" } } },
      }),
    );
    expect(await generatedRootTreeHasNoProviderUsage(root)).toBe(false);
  });
});

test("an unparsable JSON config file reports an incomplete scan", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "broken.tf.json"), "{ not json");
    const scan = await requiredProviderSourcesFromTerraformTree(root);
    expect(scan.complete).toBe(false);
  });
});

test("a tree over the file cap reports an incomplete scan", async () => {
  await withRoot(async (root) => {
    await writeFile(
      join(root, "providers.tf"),
      'terraform {\n  required_providers {\n    cloudflare = {\n      source = "cloudflare/cloudflare"\n    }\n  }\n}\n',
    );
    for (let index = 0; index <= CAPSULE_COMPATIBILITY_MAX_FILES; index += 1) {
      await writeFile(join(root, `pad${index}.tf`), "# pad\n");
    }
    const scan = await requiredProviderSourcesFromTerraformTree(root);
    expect(scan.complete).toBe(false);
  });
});

test("an unreadable generated root reports an incomplete scan", async () => {
  const scan = await requiredProviderSourcesFromTerraformTree(
    join(tmpdir(), "takosumi-provider-scan-missing-root"),
  );
  expect(scan.complete).toBe(false);
});

// An incomplete scan is indistinguishable from a clean one, so a profile that
// carries a provider policy must refuse to init rather than enforce the
// allow/deny list against providers it never saw.
test("pre-init policy refuses to enforce a provider policy on an incomplete scan", () => {
  expect(() =>
    assertRunnerPolicyBeforeInit(REQUEST, ALLOWLIST_PROFILE, EMPTY_CONTEXT, {
      allowProviderFreeGeneratedRoot: true,
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
      providerScanComplete: false,
    }),
  ).toThrow(/provider scan did not complete/);
  expect(() =>
    assertRunnerPolicyBeforeInit(
      REQUEST,
      { id: "deny-only", deniedProviders: ["attacker/evil"] },
      EMPTY_CONTEXT,
      {
        allowProviderFreeGeneratedRoot: true,
        requiredProviders: [],
        providerScanComplete: false,
      },
    ),
  ).toThrow(/provider scan did not complete/);
  expect(() =>
    assertRunnerPolicyBeforeInit(REQUEST, ALLOWLIST_PROFILE, EMPTY_CONTEXT, {
      allowProviderFreeGeneratedRoot: true,
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
      providerScanComplete: true,
    }),
  ).not.toThrow();
});
