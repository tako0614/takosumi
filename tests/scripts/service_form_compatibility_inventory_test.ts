import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildServiceFormCompatibilityInventory,
  parseStateProviderAddress,
  stableCompatibilityInventoryJson,
} from "../../scripts/lib/service-form-compatibility-inventory.ts";
import { runServiceFormCompatibilityInventoryCli } from "../../scripts/report-service-form-compatibility-inventory.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const STATE = JSON.stringify({
  version: 4,
  serial: 41,
  lineage: "must-not-be-copied",
  resources: [
    {
      mode: "managed",
      type: "takosumi_edge_worker",
      provider:
        'module.platform.provider["registry.opentofu.org/takosjp/takosumi"].legacy',
      instances: [
        {
          schema_version: 0,
          attributes: {
            id: "tkrn:secret-space:EdgeWorker:private-name",
            token: "must-never-appear",
          },
        },
      ],
    },
    {
      mode: "managed",
      type: "takosumi_target_pool",
      provider: 'provider["registry.opentofu.org/takosjp/takosumi"]',
      instances: [{ attributes: { credential_ref: "secret-connection" } }],
    },
    {
      mode: "managed",
      type: "takoform_queue",
      provider: 'provider["registry.terraform.io/tako0614/takoform"]',
      instances: [{ attributes: { name: "private-queue" } }],
    },
    {
      mode: "managed",
      type: "aws_s3_bucket",
      provider: 'provider["registry.terraform.io/hashicorp/aws"]',
      instances: [{ attributes: { bucket: "private-bucket" } }],
    },
  ],
});

const LOCK = `
provider "registry.opentofu.org/takosjp/takosumi" {
  version     = "1.0.1"
  constraints = "~> 1.0"
  hashes = [
    "h1:takosumi-public-checksum",
    "zh:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ]
}

provider "registry.terraform.io/tako0614/takoform" {
  version = "0.1.0"
  hashes = [
    "h1:takoform-public-checksum",
  ]
}

provider "registry.terraform.io/hashicorp/aws" {
  version = "6.0.0"
  hashes = ["h1:other-provider"]
}
`;

describe("Service Form compatibility inventory", () => {
  test("reports only compatibility identities and never state values", () => {
    const inventory = buildServiceFormCompatibilityInventory([
      { kind: "terraform_state", bytes: new TextEncoder().encode(STATE) },
      { kind: "dependency_lock", bytes: new TextEncoder().encode(LOCK) },
    ]);

    expect(inventory.summary).toEqual({
      terraformStateCount: 1,
      dependencyLockCount: 1,
      relevantResourceCount: 3,
      relevantInstanceCount: 3,
      otherResourceCount: 1,
      otherProviderLockCount: 1,
    });
    expect(inventory.resources.map((entry) => entry.resourceClass)).toEqual([
      "portable_form",
      "legacy_form",
      "takosumi_admin",
    ]);
    expect(
      inventory.providerLocks.map((entry) => entry.providerAddress),
    ).toEqual([
      "registry.opentofu.org/takosjp/takosumi",
      "registry.terraform.io/tako0614/takoform",
    ]);
    expect(inventory.removalDecision.eligible).toBe(false);

    const output = stableCompatibilityInventoryJson(inventory);
    for (const secret of [
      "must-never-appear",
      "secret-space",
      "private-name",
      "secret-connection",
      "private-queue",
      "private-bucket",
      "must-not-be-copied",
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  test("normalizes module and alias provider references", () => {
    expect(
      parseStateProviderAddress(
        'module.app.provider["registry.opentofu.org/takosjp/takosumi"].old',
      ),
    ).toBe("registry.opentofu.org/takosjp/takosumi");
    expect(
      parseStateProviderAddress(
        'provider["registry.terraform.io/tako0614/takoform"]',
      ),
    ).toBe("registry.terraform.io/tako0614/takoform");
    expect(parseStateProviderAddress("malformed[provider")).toBeNull();
  });

  test("fails closed on empty input and malformed state", () => {
    expect(() => buildServiceFormCompatibilityInventory([])).toThrow(
      "at least one state or dependency-lock input is required",
    );
    expect(() =>
      buildServiceFormCompatibilityInventory([
        {
          kind: "terraform_state",
          bytes: new TextEncoder().encode(
            '{"secret":"malformed-secret-must-not-leak"',
          ),
        },
      ]),
    ).toThrow("Terraform/OpenTofu state is not valid JSON");
    try {
      buildServiceFormCompatibilityInventory([
        {
          kind: "terraform_state",
          bytes: new TextEncoder().encode(
            '{"secret":"malformed-secret-must-not-leak"',
          ),
        },
      ]);
    } catch (error) {
      expect(String(error)).not.toContain("malformed-secret-must-not-leak");
    }
  });

  test("creates a report once and refuses to overwrite evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "service-form-inventory-"));
    temporaryRoots.push(root);
    const statePath = join(root, "terraform.tfstate");
    const outputPath = join(root, "inventory.json");
    await writeFile(statePath, STATE);

    await runServiceFormCompatibilityInventoryCli([
      "--state",
      statePath,
      "--output",
      outputPath,
    ]);
    const output = await readFile(outputPath, "utf8");
    expect(output).toContain(
      '"kind": "takosumi.service-form-compatibility-inventory@v1"',
    );
    await expect(
      runServiceFormCompatibilityInventoryCli([
        "--state",
        statePath,
        "--output",
        outputPath,
      ]),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });
});
