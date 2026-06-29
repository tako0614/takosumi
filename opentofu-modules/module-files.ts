import type { DispatchGeneratedRoot } from "@takosumi/internal/deploy-control-api";

export type FirstPartyModuleFiles = NonNullable<
  DispatchGeneratedRoot["moduleFiles"]
>;

function hcl(strings: TemplateStringsArray): string {
  return strings[0] ?? "";
}

const coreMainTf = hcl`# core (first-party base Capsule module)
#
# The base Capsule module for a Workspace / Project. For MVP this is a pure
# value-plumbing module: it derives generic service origins from a single
# \`base_domain\` input and exposes them as outputs. It declares NO
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
  value       = "\${local.public_origin}/.well-known/takosumi-services.json"
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
  description = "Worker script name."
}

variable "accountId" {
  type        = string
  description = "Cloudflare account id that owns the Worker."
}

variable "artifactPath" {
  type        = string
  description = "Legacy first-party path to a bundled Worker module JS file."
  default     = "/work/artifact"
}

variable "compatibilityDate" {
  type        = string
  description = "Workers runtime compatibility date."
  default     = "2024-11-01"
}

variable "publicUrl" {
  type        = string
  description = "Optional public URL projected by a dispatcher/custom route after apply. Empty means this module only reports the Worker script name."
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

output "worker_name" {
  description = "Deployed Worker script name."
  value       = cloudflare_workers_script.this.script_name
}

output "url" {
  description = "Public URL projected outside this module, or empty when no dispatcher/custom route projection is configured."
  value       = var.publicUrl
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

const cloudflareHelloWorkerMainTf = hcl`terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

# Starter capsule: a runnable Cloudflare Worker with NO build step and a
# workers.dev URL. Unlike cloudflare-worker-service (which uploads a built
# artifact) this bakes the Worker source inline. Provider credentials are minted
# by Takosumi at dispatch (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID); no
# inline secrets.

variable "accountId" {
  type        = string
  description = "Cloudflare account id that owns the Worker."
}

variable "appName" {
  type        = string
  description = "Worker script name."
  default     = "takosumi-hello"
}

variable "workersSubdomain" {
  type        = string
  description = "The Cloudflare Workers subdomain for the account, without .workers.dev."
}

variable "compatibilityDate" {
  type        = string
  description = "Workers runtime compatibility date."
  default     = "2025-01-01"
}

# Inline ES-module Worker — a tiny HTML page so a fresh install has something
# real to open. No build pipeline, no artifact file. The Worker source is a
# heredoc using single-quoted JS strings (HTML attributes use double quotes),
# so the module stays free of backticks and \`$\${}\` interpolation.
locals {
  worker_module = <<-EOT
    export default { async fetch() { return new Response('<!doctype html><meta charset="utf-8"><title>Hello from Takosumi</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:36rem;margin:12vh auto;padding:0 1.5rem;color:#1a1a1a}</style><h1>It works</h1><p>This Worker was provisioned by a Takosumi Capsule: reviewed plan, applied, live.</p><p>Edit the capsule and re-deploy to make it yours.</p>', { headers: { 'content-type': 'text/html; charset=utf-8' } }); } };
  EOT
}

resource "cloudflare_workers_script" "this" {
  account_id         = var.accountId
  script_name        = var.appName
  content            = local.worker_module
  main_module        = "index.js"
  compatibility_date = var.compatibilityDate
}

resource "cloudflare_workers_script_subdomain" "this" {
  account_id  = var.accountId
  script_name = cloudflare_workers_script.this.script_name
  enabled     = true
}

output "worker_name" {
  description = "Deployed Worker script name."
  value       = cloudflare_workers_script.this.script_name
}

output "url" {
  description = "Public workers.dev URL for the deployed Worker."
  value       = cloudflare_workers_script_subdomain.this.enabled ? "https://\${cloudflare_workers_script.this.script_name}.\${var.workersSubdomain}.workers.dev" : ""
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

const takosumiAiEndpointMainTf = hcl`variable "endpointName" {
  type        = string
  description = "Logical AI endpoint name."
}

variable "implementation" {
  type        = string
  description = "Resolver-selected implementation, such as cloudflare_ai_gateway or openai_compatible_ai_endpoint."
}

variable "targetName" {
  type        = string
  description = "Resolver-selected TargetPool entry name."
}

variable "targetType" {
  type        = string
  description = "Resolver-selected Target type."
}

variable "baseUrl" {
  type        = string
  description = "Public or internal base URL projected by the selected target/adapter. Empty means the adapter owns projection."
  default     = ""
}

variable "defaultModel" {
  type        = string
  description = "Optional public default model alias."
  default     = ""
}

variable "allowedModels" {
  type        = list(string)
  description = "Optional public model alias allow-list."
  default     = []
}

variable "interfaces" {
  type        = list(string)
  description = "Requested AI API interfaces, for example openai_chat_completions."
}

variable "profiles" {
  type        = list(string)
  description = "Requested compatibility profiles, for example openai_compatible."
  default     = []
}

locals {
  projected_base_url = var.baseUrl
}

output "base_url" {
  description = "OpenAI-compatible or profile-specific endpoint base URL when projected by the selected adapter."
  value       = local.projected_base_url
}

output "default_model" {
  description = "Default public model alias for this endpoint, if configured."
  value       = var.defaultModel
}
`;

export const firstPartyModuleFilesByTemplateId: Readonly<
  Record<string, FirstPartyModuleFiles>
> = Object.freeze({
  core: [{ path: "main.tf", text: coreMainTf }],
  "cloudflare-hello-worker": [
    { path: "main.tf", text: cloudflareHelloWorkerMainTf },
  ],
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
  "takosumi-ai-endpoint": [{ path: "main.tf", text: takosumiAiEndpointMainTf }],
});
