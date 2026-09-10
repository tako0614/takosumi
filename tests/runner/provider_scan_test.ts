import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  assertRunnerPolicyBeforeInit,
  assertProviderSetStableAfterInit,
  generatedRootTreeHasNoProviderUsage,
  hasProviderUsageBeforeInit,
  requiredProvidersForGeneratedRoot,
  requiredProviderSourcesFromTerraformTree,
} from "../../runner/lib/providers.ts";
import {
  CAPSULE_COMPATIBILITY_MAX_FILES,
  DEFAULT_PROVIDER_LOCKFILE_ARTIFACT_MAX_BYTES,
} from "../../runner/lib/constants.ts";
import { initPlanAndBuildResponse } from "../../runner/lib/plan_apply.ts";
import type { RunWorkspace } from "../../runner/lib/types.ts";
import { generateOpenTofuChildModuleRoot } from "../../lib/rootgen/src/mod.ts";
import { runProviderLockfileFifoChild } from "./provider_lockfile_fifo_fixture.ts";

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

function pipelineWorkspace(root: string): RunWorkspace {
  return {
    root,
    sourceRoot: root,
    moduleDir: root,
    planPath: join(root, "tfplan"),
    providerLockfilePath: join(root, "provider-lockfile.hcl"),
    restoredStatePath: join(root, "terraform.tfstate"),
    moduleInfoPath: join(root, "module-info.json"),
    generatedRootDir: join(root, "generated-root"),
    childModuleDir: join(root, "generated-root", "module"),
    artifactDir: join(root, "artifact"),
    depsDir: join(root, "deps"),
  };
}

async function fakeTofu(
  script: string,
): Promise<{ readonly bin: string; readonly cleanup: () => Promise<void> }> {
  const bin = await mkdtemp(join(tmpdir(), "takosumi-provider-scan-bin-"));
  const tofu = join(bin, "tofu");
  await writeFile(tofu, script);
  await chmod(tofu, 0o755);
  return {
    bin,
    cleanup: async () => {
      await rm(bin, { recursive: true, force: true });
    },
  };
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

const FAKE_PLAN_TOFU = `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  init)
    ;;
  plan)
    out=""
    previous=""
    for arg in "$@"; do
      if [ "$previous" = "-out" ]; then out="$arg"; fi
      previous="$arg"
    done
    test -n "$out"
    printf 'fake-plan' > "$out"
    ;;
  show)
    printf '{"format_version":"1.2","resource_changes":[]}'
    ;;
  *)
    echo "unexpected tofu command: $*" >&2
    exit 2
    ;;
esac
`;

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

test("generated root exact provider versions survive runner requirement rescan", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, "module"), { recursive: true });
    const requirement = {
      source: "registry.opentofu.org/hashicorp/aws",
      moduleLocalName: "aws",
      version: "3.0.0",
    } as const;
    const generatedRoot = generateOpenTofuChildModuleRoot({
      rootProviderRequirements: [requirement],
      inputs: {},
      outputAllowlist: {},
    });
    for (const [name, content] of Object.entries(generatedRoot.files)) {
      await writeFile(join(root, name), content);
    }
    await writeFile(join(root, "module", "main.tf"), 'output "ok" { value = true }\n');

    await expect(
      requiredProvidersForGeneratedRoot(
        {
          planRun: {
            requiredProviders: [requirement.source],
            requiredProviderRequirements: [{ ...requirement, allowed: true }],
          },
        },
        root,
      ),
    ).resolves.toMatchObject({
      complete: true,
      providers: [requirement.source],
      requirements: [requirement],
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

test("builtin-only provider usage needs no dependency lock but rejects an impossible builtin lock row", async () => {
  await withRoot(async (root) => {
    const builtinSource = [
      'terraform { required_providers { terraform = { source = "terraform.io/builtin/terraform" } } }',
      'data "terraform_remote_state" "shared" { backend = "local" config = { path = "shared.tfstate" } }',
      'output "encoded" { value = provider::terraform::encode_expr(data.terraform_remote_state.shared.outputs) }',
      "",
    ].join("\n");
    await writeFile(
      join(root, "main.tf"),
      builtinSource,
    );
    const scan = await requiredProviderSourcesFromTerraformTree(root);
    expect(scan).toMatchObject({
      complete: true,
      providers: [],
      requirements: [],
    });
    const allowProviderFreeGeneratedRoot =
      await generatedRootTreeHasNoProviderUsage(root);
    expect(allowProviderFreeGeneratedRoot).toBe(true);
    expect(hasProviderUsageBeforeInit(builtinSource)).toBe(false);
    expect(
      hasProviderUsageBeforeInit('resource "aws_instance" "external" {}'),
    ).toBe(true);
    await expect(
      requiredProvidersForGeneratedRoot(
        {
          planRun: {
            requiredProviders: ["terraform.io/builtin/terraform"],
            requiredProviderRequirements: [
              {
                source: "terraform.io/builtin/terraform",
                moduleLocalName: "terraform",
                allowed: true,
              },
            ],
          },
        },
        root,
      ),
    ).resolves.toMatchObject({
      complete: true,
      providers: [],
      requirements: [],
    });
    expect(() =>
      assertRunnerPolicyBeforeInit(REQUEST, ALLOWLIST_PROFILE, EMPTY_CONTEXT, {
        allowProviderFreeGeneratedRoot,
        requiredProviders: ["terraform.io/builtin/terraform"],
        providerScanComplete: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertProviderSetStableAfterInit(scan, scan, undefined),
    ).not.toThrow();
    expect(() =>
      assertProviderSetStableAfterInit(
        scan,
        scan,
        'provider "terraform.io/builtin/terraform" {}\n',
      ),
    ).toThrow(/does not match/);
  });
});

test("post-init lock comparison omits builtins but still requires every installable provider", async () => {
  await withRoot(async (root) => {
    await writeFile(
      join(root, "provider.tf"),
      [
        'terraform { required_providers { cloudflare = { source = "cloudflare/cloudflare" } terraform = { source = "terraform.io/builtin/terraform" } } }',
        'output "encoded" { value = provider::terraform::encode_expr("ready") }',
        "",
      ].join("\n"),
    );
    const scan = await requiredProviderSourcesFromTerraformTree(root);
    expect(scan.complete).toBe(true);
    expect(scan.providers).toEqual([
      "registry.opentofu.org/cloudflare/cloudflare",
    ]);

    const installableLock =
      'provider "registry.opentofu.org/cloudflare/cloudflare" {}\n';
    expect(() =>
      assertProviderSetStableAfterInit(scan, scan, installableLock),
    ).not.toThrow();

    const missingInstallableLock =
      'provider "terraform.io/builtin/terraform" {}\n';
    expect(() =>
      assertProviderSetStableAfterInit(scan, scan, missingInstallableLock),
    ).toThrow(/does not match/);
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
      join(root, "external.tf"),
      'resource "aws_instance" "external" {}\n',
    );
    expect(await generatedRootTreeHasNoProviderUsage(root)).toBe(false);
    await rm(join(root, "external.tf"));
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

test("post-init lockfile FIFO is rejected without blocking the runner", async () => {
  await withRoot(async (root) => {
    await writeFile(
      join(root, "provider.tf"),
      'terraform { required_providers { aws = { source = "hashicorp/aws" } } }\n',
    );
    const fake = await fakeTofu(`#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = init ]; then
  rm -f .terraform.lock.hcl
  mkfifo .terraform.lock.hcl
  # The parent starts its FIFO-operation watchdog after init setup is done.
  : > "\${FIFO_READY_PATH:?}"
  exit 0
fi
echo "unexpected tofu command: $*" >&2
exit 2
`);
    const runId = `provider-lock-fifo-${crypto.randomUUID()}`;
    const readyPath = join(root, "provider-lock-fifo.ready");
    try {
      const child = await runProviderLockfileFifoChild({
        mode: "pipeline",
        root,
        runId,
        readyPath,
        fakeTofuBin: fake.bin,
      });
      expect(child.phase).toBe("completed");
      expect(child.exitCode).toBe(0);
      const output = child.stdout.trim().split(/\r?\n/u).at(-1);
      expect(output).toBeDefined();
      const outcome = JSON.parse(output ?? "null") as
        | { readonly ok: true; readonly result: unknown }
        | { readonly ok: false; readonly error: string };
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("FIFO lockfile unexpectedly succeeded");
      expect(outcome.error).toContain(
        "OpenTofu dependency lock is not a physical regular file",
      );
    } finally {
      await fake.cleanup();
    }
  });
}, 10_000);

test("provider-free plans report explicit lockfile absence", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "main.tf"), "terraform {}\n");
    const providerScan = await requiredProviderSourcesFromTerraformTree(root);
    const fake = await fakeTofu(FAKE_PLAN_TOFU);
    const workspace = pipelineWorkspace(root);
    try {
      const result = await initPlanAndBuildResponse(
        `provider-free-absent-${crypto.randomUUID()}`,
        workspace,
        root,
        {
          operation: "create",
          commandContext: {
            env: { PATH: `${fake.bin}:${Bun.env.PATH ?? ""}` },
          },
          requiredProviders: providerScan.providers,
          providerScan,
        },
      );

      expect(result.status).toBe("succeeded");
      expect(result.providerLockDigest).toBeUndefined();
      expect(result.providerLockArtifact).toBeNull();
    } finally {
      await fake.cleanup();
    }
  });
});

test("provider-free plans retain exact present lockfile bytes, including empty files", async () => {
  for (const [label, lockBytes] of [
    ["comment", new TextEncoder().encode("# retained exactly\r\n")],
    ["empty", new Uint8Array()],
  ] as const) {
    await withRoot(async (root) => {
      await writeFile(join(root, "main.tf"), "terraform {}\n");
      const providerScan = await requiredProviderSourcesFromTerraformTree(root);
      const lockSource = join(root, "lockfile.fixture");
      await writeFile(lockSource, lockBytes);
      const fake = await fakeTofu(`#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  init)
    cp "$LOCK_SOURCE" .terraform.lock.hcl
    ;;
  plan)
    out=""
    previous=""
    for arg in "$@"; do
      if [ "$previous" = "-out" ]; then out="$arg"; fi
      previous="$arg"
    done
    test -n "$out"
    printf 'fake-plan' > "$out"
    ;;
  show)
    printf '{"format_version":"1.2","resource_changes":[]}'
    ;;
  *)
    echo "unexpected tofu command: $*" >&2
    exit 2
    ;;
esac
`);
      const workspace = pipelineWorkspace(root);
      const runId = `provider-free-present-${label}-${crypto.randomUUID()}`;
      try {
        const result = await initPlanAndBuildResponse(
          runId,
          workspace,
          root,
          {
            operation: "create",
            commandContext: {
              env: {
                PATH: `${fake.bin}:${Bun.env.PATH ?? ""}`,
                LOCK_SOURCE: lockSource,
              },
            },
            requiredProviders: providerScan.providers,
            providerScan,
          },
        );
        const expectedDigest = await digestBytes(lockBytes);

        expect(result.status).toBe("succeeded");
        expect(result.providerLockDigest).toBe(expectedDigest);
        expect(result.providerLockArtifact).toEqual({
          kind: "runner-local",
          ref: `runner-local://${runId}/provider-lockfile`,
          digest: expectedDigest,
          contentType: "application/vnd.opentofu.lock.hcl",
          sizeBytes: lockBytes.byteLength,
        });
        await expect(readFile(workspace.providerLockfilePath)).resolves.toEqual(
          lockBytes,
        );
      } finally {
        await fake.cleanup();
      }
    });
  }
});

test("provider lockfile capture rejects files over the configured cap", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "main.tf"), "terraform {}\n");
    const providerScan = await requiredProviderSourcesFromTerraformTree(root);
    const lockSource = join(root, "oversized-lockfile.fixture");
    await writeFile(
      lockSource,
      new Uint8Array(DEFAULT_PROVIDER_LOCKFILE_ARTIFACT_MAX_BYTES + 1),
    );
    const fake = await fakeTofu(`#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = init ]; then
  cp "$LOCK_SOURCE" .terraform.lock.hcl
  exit 0
fi
exit 2
`);
    try {
      await expect(
        initPlanAndBuildResponse(
          `provider-lock-oversized-${crypto.randomUUID()}`,
          pipelineWorkspace(root),
          root,
          {
            operation: "create",
            commandContext: {
              env: {
                PATH: `${fake.bin}:${Bun.env.PATH ?? ""}`,
                LOCK_SOURCE: lockSource,
              },
            },
            requiredProviders: providerScan.providers,
            providerScan,
          },
        ),
      ).rejects.toThrow(
        `OpenTofu provider lockfile exceeds ${DEFAULT_PROVIDER_LOCKFILE_ARTIFACT_MAX_BYTES} bytes`,
      );
    } finally {
      await fake.cleanup();
    }
  });
});
