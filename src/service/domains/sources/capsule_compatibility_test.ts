import { expect, test } from "bun:test";

import {
  analyzeOpenTofuCapsuleFiles,
  normalizedCapsuleArtifactBody,
  normalizedModuleObjectKey,
} from "./capsule_compatibility.ts";
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
