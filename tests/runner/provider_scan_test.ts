import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  assertRunnerPolicyBeforeInit,
  assertProviderSetStableAfterInit,
  generatedRootTreeHasNoProviderUsage,
  requiredProvidersForGeneratedRoot,
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

test("canonical provider scan follows only reachable local modules across every config spelling", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, "modules", "child"), { recursive: true });
    await mkdir(join(root, "examples", "unselected"), { recursive: true });
    await writeFile(
      join(root, "main.tf"),
      [
        'module "child" {',
        '  source = "./modules/child"',
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "providers.tofu"),
      [
        "terraform {",
        "  required_providers {",
        "    edge = {",
        '      source = "cloudflare/cloudflare"',
        '      version = "~> 5.0"',
        "      configuration_aliases = [edge.zone]",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "modules", "child", "providers.tf.json"),
      `${JSON.stringify({
        terraform: {
          required_providers: {
            random: {
              source: "hashicorp/random",
              version: "= 3.7.2",
            },
          },
        },
      })}\n`,
    );
    await writeFile(
      join(root, "modules", "child", "time.tofu.json"),
      `${JSON.stringify({
        terraform: {
          required_providers: {
            clock: { source: "hashicorp/time" },
          },
        },
      })}\n`,
    );
    await writeFile(
      join(root, "examples", "unselected", "main.tf"),
      'terraform { required_providers { evil = { source = "attacker/evil" } } }\n',
    );

    const scan = await requiredProviderSourcesFromTerraformTree(root);
    expect(scan.complete).toBe(true);
    expect(scan.providers).toEqual([
      "registry.opentofu.org/cloudflare/cloudflare",
      "registry.opentofu.org/hashicorp/random",
      "registry.opentofu.org/hashicorp/time",
    ]);
    expect(scan.requirements).toEqual([
      {
        source: "registry.opentofu.org/cloudflare/cloudflare",
        moduleLocalName: "edge",
      },
      {
        source: "registry.opentofu.org/cloudflare/cloudflare",
        moduleLocalName: "edge",
        childAlias: "zone",
      },
    ]);
  });
});

test("runner allows reachable child packages without inventing selected-root bindings", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, "modules", "child"), { recursive: true });
    await writeFile(
      join(root, "main.tf"),
      [
        'terraform { required_providers { aws = { source = "hashicorp/aws" } } }',
        'module "child" { source = "./modules/child" }',
      ].join("\n"),
    );
    await writeFile(
      join(root, "modules", "child", "providers.tf"),
      'terraform { required_providers { edge = { source = "cloudflare/cloudflare" configuration_aliases = [edge.zone] } } }',
    );

    const scan = await requiredProviderSourcesFromTerraformTree(root);
    expect(scan.providers).toEqual([
      "registry.opentofu.org/cloudflare/cloudflare",
      "registry.opentofu.org/hashicorp/aws",
    ]);
    expect(scan.requirements).toEqual([
      {
        source: "registry.opentofu.org/hashicorp/aws",
        moduleLocalName: "aws",
      },
    ]);
    await expect(
      requiredProvidersForGeneratedRoot(
        {
          planRun: {
            requiredProviders: scan.providers,
            requiredProviderRequirements: scan.requirements.map(
              (requirement) => ({ ...requirement, allowed: true }),
            ),
          },
        },
        root,
      ),
    ).resolves.toMatchObject({
      providers: scan.providers,
      requirements: scan.requirements,
    });
  });
});

test("canonical provider scan represents zero and one provider without inventing credentials", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "main.tofu"), 'output "ok" { value = true }\n');
    expect(await requiredProviderSourcesFromTerraformTree(root)).toMatchObject({
      complete: true,
      providers: [],
      requirements: [],
    });
    await writeFile(
      join(root, "provider.tf"),
      'terraform { required_providers { local = { source = "hashicorp/local" } } }\n',
    );
    expect(await requiredProviderSourcesFromTerraformTree(root)).toMatchObject({
      complete: true,
      providers: ["registry.opentofu.org/hashicorp/local"],
      requirements: [
        {
          source: "registry.opentofu.org/hashicorp/local",
          moduleLocalName: "local",
        },
      ],
    });
  });
});

test("post-init provider observation rejects source growth, alias change, and lock disagreement before Plan", async () => {
  await withRoot(async (root) => {
    await writeFile(
      join(root, "provider.tf"),
      'terraform { required_providers { edge = { source = "cloudflare/cloudflare" } } }\n',
    );
    const before = await requiredProviderSourcesFromTerraformTree(root);
    const matchingLock =
      'provider "registry.opentofu.org/cloudflare/cloudflare" {}\n';
    expect(() =>
      assertProviderSetStableAfterInit(before, before, matchingLock),
    ).not.toThrow();

    await writeFile(
      join(root, "provider.tf"),
      'terraform { required_providers { edge = { source = "cloudflare/cloudflare" configuration_aliases = [edge.zone] } } }\n',
    );
    const changed = await requiredProviderSourcesFromTerraformTree(root);
    expect(() =>
      assertProviderSetStableAfterInit(before, changed, matchingLock),
    ).toThrow(/requirements changed/);
    expect(() =>
      assertProviderSetStableAfterInit(
        before,
        before,
        'provider "registry.opentofu.org/hashicorp/random" {}\n',
      ),
    ).toThrow(/does not match/);
    expect(() =>
      assertProviderSetStableAfterInit(before, before, undefined),
    ).toThrow(/lock is missing/);
  });
});

test("runner derivation binds every exact compatibility-reviewed provider identity", async () => {
  await withRoot(async (root) => {
    await writeFile(
      join(root, "provider.tf"),
      'terraform { required_providers { edge = { source = "cloudflare/cloudflare" configuration_aliases = [edge.zone] } } }\n',
    );
    const request = {
      planRun: {
        requiredProviders: ["cloudflare/cloudflare"],
        requiredProviderRequirements: [
          {
            source: "registry.opentofu.org/cloudflare/cloudflare",
            moduleLocalName: "edge",
            allowed: true,
          },
          {
            source: "registry.opentofu.org/cloudflare/cloudflare",
            moduleLocalName: "edge",
            childAlias: "zone",
            allowed: true,
          },
        ],
      },
    };
    await expect(requiredProvidersForGeneratedRoot(request, root)).resolves.toMatchObject({
      complete: true,
      requirements: [
        {
          source: "registry.opentofu.org/cloudflare/cloudflare",
          moduleLocalName: "edge",
        },
        {
          source: "registry.opentofu.org/cloudflare/cloudflare",
          moduleLocalName: "edge",
          childAlias: "zone",
        },
      ],
    });
    await expect(
      requiredProvidersForGeneratedRoot(
        {
          planRun: {
            ...request.planRun,
            requiredProviderRequirements:
              request.planRun.requiredProviderRequirements.slice(0, 1),
          },
        },
        root,
      ),
    ).rejects.toThrow(/do not match/);
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
