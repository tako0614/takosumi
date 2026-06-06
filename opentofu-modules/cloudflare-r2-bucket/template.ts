/**
 * Official template: cloudflare-r2-bucket.
 *
 * Authored as TypeScript catalog data (the service cannot read the filesystem
 * in Workers). The `module/` directory next to this file is the human-readable
 * OpenTofu surface and is baked into the runner image at
 * `source.localModulePath`. Keep this object in sync with `module/main.tf`.
 */

import type { TemplateDefinition } from "takosumi-contract/deploy-control-api";

export const cloudflareR2BucketTemplate: TemplateDefinition = {
  id: "cloudflare-r2-bucket",
  name: "Cloudflare R2 Bucket",
  version: "1.0.0",
  description:
    "Provisions a single Cloudflare R2 bucket from a name and account id.",
  source: {
    localModulePath: "/app/templates/cloudflare-r2-bucket/module",
  },
  inputs: {
    bucketName: {
      type: "string",
      title: "Bucket name",
      required: true,
      description: "Globally-scoped R2 bucket name within the account.",
    },
    accountId: {
      type: "string",
      title: "Cloudflare account id",
      required: true,
      description: "Account that will own the bucket.",
    },
    location: {
      type: "string",
      title: "Location hint",
      required: false,
      description: "Optional R2 jurisdiction/region hint.",
      default: "",
    },
  },
  outputs: {
    public: {
      bucket_name: { type: "string", from: "bucket_name" },
      location: { type: "string", from: "location" },
    },
  },
  policy: {
    allowedProviders: ["cloudflare/cloudflare"],
    allowedResourceTypes: ["cloudflare_r2_bucket"],
    destructiveChanges: { requireExplicitConfirmation: true },
  },
};
