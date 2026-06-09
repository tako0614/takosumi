import type { DispatchGeneratedRoot } from "@takosumi/internal/deploy-control-api";

export type FirstPartyModuleFiles = NonNullable<
  DispatchGeneratedRoot["moduleFiles"]
>;

function hcl(strings: TemplateStringsArray): string {
  return strings[0] ?? "";
}

const coreMainTf = hcl`# core (first-party base-installation module)
#
# The base Installation under a Space (spec §5/§10). For MVP this is a pure
# value-plumbing module: it derives the canonical Takos service origins from a
# single \`base_domain\` input and exposes them as outputs. It declares NO
# providers and creates NO cloud resources, so it plans against an empty
# provider set.

variable "base_domain" {
  type        = string
  description = "Base domain for this installation (e.g. example.com). Drives every derived origin."

  validation {
    condition     = length(trimspace(var.base_domain)) > 0
    error_message = "base_domain must be a non-empty domain name."
  }
}

variable "display_name" {
  type        = string
  description = "Optional human-readable name for the installation."
  default     = ""
}

locals {
  base_domain  = trimspace(var.base_domain)
  public_origin = "https://\${local.base_domain}"
}

output "base_domain" {
  description = "The normalized base domain for this installation."
  value       = local.base_domain
}

output "public_origin" {
  description = "Public HTTPS origin derived from base_domain."
  value       = local.public_origin
}

output "member_issuer" {
  description = "OIDC issuer origin for members (the embedded accounts plane)."
  value       = "\${local.public_origin}/auth"
}

output "service_registry_url" {
  description = "Well-known service registry URL advertised by this installation."
  value       = "\${local.public_origin}/.well-known/takos-services.json"
}
`;

const cloudflareR2StorageMainTf = hcl`terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

variable "bucketName" {
  type        = string
  description = "Name of the R2 bucket to create."
}

variable "accountId" {
  type        = string
  description = "Cloudflare account id that owns the bucket."
}

variable "location" {
  type        = string
  description = "Optional R2 location hint (jurisdiction/region). Empty selects the provider default."
  default     = ""
}

# Provider credentials are supplied through environment (CLOUDFLARE_API_TOKEN /
# CLOUDFLARE_ACCOUNT_ID) minted by Takosumi at dispatch; no provider block needs
# inline secrets here.

resource "cloudflare_r2_bucket" "this" {
  account_id = var.accountId
  name       = var.bucketName
  location   = var.location != "" ? var.location : null
}

output "bucket_name" {
  description = "Name of the created R2 bucket."
  value       = cloudflare_r2_bucket.this.name
}

output "location" {
  description = "Resolved R2 location for the bucket."
  value       = cloudflare_r2_bucket.this.location
}
`;

const cloudflareWorkerServiceMainTf = hcl`terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

variable "appName" {
  type        = string
  description = "Worker script name (used in the workers.dev URL and route config)."
}

variable "accountId" {
  type        = string
  description = "Cloudflare account id that owns the Worker."
}

variable "artifactPath" {
  type        = string
  description = "Path to the bundled Worker module JS produced by the build phase (copied to /work/artifact by the runner)."
  default     = "/work/artifact"
}

variable "compatibilityDate" {
  type        = string
  description = "Workers runtime compatibility date."
  default     = "2024-11-01"
}

variable "workersDev" {
  type        = bool
  description = "Whether to expose the Worker on the workers.dev subdomain."
  default     = true
}

variable "accountSubdomain" {
  type        = string
  description = "The account's workers.dev subdomain (the <name> in <name>.workers.dev). Used only to render the public url output."
  default     = ""
}

# cloudflare_workers_script (provider v5): module-syntax upload. \`content\` carries
# the bundled JS verbatim; \`main_module\` names the uploaded module that exports
# the fetch handler. Provider credentials are minted by Takosumi at dispatch via
# CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID; no inline secrets here.
resource "cloudflare_workers_script" "this" {
  account_id         = var.accountId
  script_name        = var.appName
  content            = file(var.artifactPath)
  main_module        = "index.js"
  compatibility_date = var.compatibilityDate
}

# Optionally expose the Worker on <account>.workers.dev.
resource "cloudflare_workers_script_subdomain" "this" {
  count       = var.workersDev ? 1 : 0
  account_id  = var.accountId
  script_name = cloudflare_workers_script.this.script_name
  enabled     = true
}

output "worker_name" {
  description = "Deployed Worker script name."
  value       = cloudflare_workers_script.this.script_name
}

output "url" {
  description = "workers.dev URL for the Worker (empty when workers.dev is disabled or the account subdomain is unknown)."
  value = (
    var.workersDev && var.accountSubdomain != ""
    ? "https://\${cloudflare_workers_script.this.script_name}.\${var.accountSubdomain}.workers.dev"
    : ""
  )
}
`;

const cloudflareStaticSiteMainTf = hcl`terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

variable "projectName" {
  type        = string
  description = "Cloudflare Pages project name (also the *.pages.dev subdomain label)."
}

variable "accountId" {
  type        = string
  description = "Cloudflare account id that owns the Pages project."
}

variable "productionBranch" {
  type        = string
  description = "Git branch that maps to the production deployment."
  default     = "main"
}

# Provider credentials are minted by Takosumi at dispatch via
# CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID; no inline secrets here.
resource "cloudflare_pages_project" "this" {
  account_id        = var.accountId
  name              = var.projectName
  production_branch = var.productionBranch
}

output "project_name" {
  description = "Deployed Pages project name."
  value       = cloudflare_pages_project.this.name
}

output "url" {
  description = "Default *.pages.dev URL for the project."
  value       = "https://\${cloudflare_pages_project.this.name}.pages.dev"
}
`;

const awsS3StorageMainTf = hcl`terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

variable "bucketName" {
  type        = string
  description = "Globally-unique S3 bucket name to create."
}

variable "region" {
  type        = string
  description = "AWS region for the bucket."
  default     = "us-east-1"
}

# Provider credentials (and region) are minted by Takosumi at dispatch via the
# AWS environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION or an
# assume-role session); no inline secrets here.
provider "aws" {
  region = var.region
}

resource "aws_s3_bucket" "this" {
  bucket = var.bucketName
}

output "bucket_name" {
  description = "Name of the created S3 bucket."
  value       = aws_s3_bucket.this.bucket
}

output "bucket_arn" {
  description = "ARN of the created S3 bucket."
  value       = aws_s3_bucket.this.arn
}

output "region" {
  description = "Region the bucket was created in."
  value       = var.region
}
`;

export const firstPartyModuleFilesByTemplateId: Readonly<
  Record<string, FirstPartyModuleFiles>
> = Object.freeze({
  core: [{ path: "main.tf", text: coreMainTf }],
  "cloudflare-r2-storage": [
    { path: "main.tf", text: cloudflareR2StorageMainTf },
  ],
  "cloudflare-worker-service": [
    { path: "main.tf", text: cloudflareWorkerServiceMainTf },
  ],
  "cloudflare-static-site": [
    { path: "main.tf", text: cloudflareStaticSiteMainTf },
  ],
  "aws-s3-storage": [{ path: "main.tf", text: awsS3StorageMainTf }],
});
