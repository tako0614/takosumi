import { expect, test } from "bun:test";

import { analyzeOpenTofuCapsuleFiles } from "./capsule_compatibility.ts";
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
    { source: "hashicorp/aws", aliases: [], allowed: true },
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
        cloudflare.compute,
        cloudflare.dns
      ]
    }
  }
}

provider "cloudflare" {
  alias = "dns"
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
      aliases: ["cloudflare.compute", "cloudflare.dns"],
      allowed: true,
    },
  ]);
  expect(result.findings.map((finding) => finding.code)).toContain(
    "backend_override_candidate",
  );
  expect(result.findings.map((finding) => finding.code)).toContain(
    "provider_block_lift_candidate",
  );
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
