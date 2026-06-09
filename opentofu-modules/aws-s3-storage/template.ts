/**
 * First-party Capsule module: aws-s3-storage.
 *
 * Provisions a single AWS S3 bucket from a name and region. Authored as
 * TypeScript catalog data (the service cannot read the filesystem in Workers).
 * The `module/` directory next to this file is the human-readable OpenTofu
 * surface and is baked into the runner image at `source.localModulePath`. Keep
 * this object in sync with `module/main.tf`.
 */

import type { TemplateDefinition } from "@takosumi/internal/deploy-control-api";

export const awsS3StorageTemplate: TemplateDefinition = {
  id: "aws-s3-storage",
  name: "AWS S3 Storage",
  version: "1.0.0",
  description: "Provisions a single AWS S3 bucket from a name and region.",
  source: {
    localModulePath: "/app/templates/aws-s3-storage/module",
  },
  inputs: {
    bucketName: {
      type: "string",
      title: "Bucket name",
      required: true,
      description: "Globally-unique S3 bucket name to create.",
    },
    region: {
      type: "string",
      title: "Region",
      required: false,
      description: "AWS region for the bucket.",
      default: "us-east-1",
    },
  },
  outputs: {
    public: {
      bucket_name: { type: "string", from: "bucket_name" },
      bucket_arn: { type: "string", from: "bucket_arn" },
      region: { type: "string", from: "region" },
    },
  },
  policy: {
    allowedProviders: ["hashicorp/aws"],
    allowedResourceTypes: ["aws_s3_bucket"],
    destructiveChanges: { requireExplicitConfirmation: true },
  },
};
