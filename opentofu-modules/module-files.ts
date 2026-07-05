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

const cloudflareWorkerServiceMainTf = hcl`terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
    http = {
      source = "hashicorp/http"
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
  description = "OpenTofu-runner-local path to a bundled Worker module JS file. Leave empty when artifactUrl is used."
  default     = ""
}

variable "artifactUrl" {
  type        = string
  description = "HTTPS URL to a CI/release-produced Worker module JS artifact. Leave empty when artifactPath is used."
  default     = ""
}

variable "artifactSha256" {
  type        = string
  description = "Expected artifact SHA-256 hex digest, optionally prefixed with sha256:. Required when artifactUrl is set."
  default     = ""
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

variable "connections" {
  type = map(object({
    resource    = string
    permissions = list(string)
    projection  = string
  }))
  description = "Non-secret Resource Shape connection metadata. The selected adapter owns concrete grant/projection materialization."
  default     = {}
}

locals {
  artifact_from_url        = trimspace(var.artifactUrl) != ""
  expected_artifact_sha256 = replace(trimspace(var.artifactSha256), "sha256:", "")
}

data "http" "artifact" {
  count = local.artifact_from_url ? 1 : 0
  url   = var.artifactUrl

  request_headers = {
    Accept = "application/javascript, text/javascript, */*"
  }
}

locals {
  artifact_content = local.artifact_from_url ? data.http.artifact[0].response_body : (trimspace(var.artifactPath) != "" ? file(var.artifactPath) : "")
}

# cloudflare_workers_script (provider v5): module-syntax upload. \`content\` carries
# the bundled JS verbatim; \`main_module\` names the uploaded module that exports
# the fetch handler. Provider credentials are minted by Takosumi at dispatch via
# CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID; no inline secrets here.
resource "cloudflare_workers_script" "this" {
  account_id         = var.accountId
  script_name        = var.appName
  content            = local.artifact_content
  main_module        = "index.js"
  compatibility_date = var.compatibilityDate

  lifecycle {
    precondition {
      condition     = local.artifact_from_url || trimspace(var.artifactPath) != ""
      error_message = "Either artifactPath or artifactUrl must be set."
    }

    precondition {
      condition     = !local.artifact_from_url || local.expected_artifact_sha256 != ""
      error_message = "artifactSha256 is required when artifactUrl is set."
    }

    precondition {
      condition     = !local.artifact_from_url || sha256(local.artifact_content) == local.expected_artifact_sha256
      error_message = "artifactSha256 does not match artifact content."
    }
  }
}

output "worker_name" {
  description = "Deployed Worker script name."
  value       = cloudflare_workers_script.this.script_name
}

output "url" {
  description = "Public URL projected outside this module, or empty when no dispatcher/custom route projection is configured."
  value       = var.publicUrl
}

output "connections" {
  description = "Declared non-secret Resource Shape connection metadata."
  value       = var.connections
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

const cloudflareR2BucketMainTf = hcl`terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

variable "accountId" {
  type        = string
  description = "Cloudflare account id that owns the R2 bucket."
}

variable "bucketName" {
  type        = string
  description = "R2 bucket name."
}

resource "cloudflare_r2_bucket" "this" {
  account_id = var.accountId
  name       = var.bucketName
}

output "bucket_name" {
  description = "Created object bucket name."
  value       = cloudflare_r2_bucket.this.name
}

output "s3_endpoint" {
  description = "S3-compatible endpoint base URL for the account-level R2 API."
  value       = "https://\${var.accountId}.r2.cloudflarestorage.com"
}
`;

const cloudflareKVStoreMainTf = hcl`terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

variable "accountId" {
  type        = string
  description = "Cloudflare account id that owns the KV namespace."
}

variable "namespaceTitle" {
  type        = string
  description = "Workers KV namespace title."
}

resource "cloudflare_workers_kv_namespace" "this" {
  account_id = var.accountId
  title      = var.namespaceTitle
}

output "namespace_id" {
  description = "Workers KV namespace id."
  value       = cloudflare_workers_kv_namespace.this.id
}

output "namespace_title" {
  description = "Workers KV namespace title."
  value       = cloudflare_workers_kv_namespace.this.title
}
`;

const cloudflareQueueMainTf = hcl`terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

variable "accountId" {
  type        = string
  description = "Cloudflare account id that owns the queue."
}

variable "queueName" {
  type        = string
  description = "Cloudflare Queue name."
}

resource "cloudflare_queue" "this" {
  account_id = var.accountId
  queue_name = var.queueName
}

output "queue_name" {
  description = "Cloudflare Queue name."
  value       = cloudflare_queue.this.queue_name
}
`;

const cloudflareSQLDatabaseMainTf = hcl`terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

variable "accountId" {
  type        = string
  description = "Cloudflare account id that owns the D1 database."
}

variable "databaseName" {
  type        = string
  description = "D1 database name."
}

resource "cloudflare_d1_database" "this" {
  account_id = var.accountId
  name       = var.databaseName
}

output "database_id" {
  description = "D1 database id."
  value       = cloudflare_d1_database.this.id
}

output "database_name" {
  description = "D1 database name."
  value       = cloudflare_d1_database.this.name
}
`;

const takosumiServiceShapeMainTf = hcl`variable "resourceName" {
  type        = string
  description = "Logical resource name."
}

variable "shape" {
  type        = string
  description = "Takosumi Resource Shape kind."
}

variable "implementation" {
  type        = string
  description = "Resolver-selected implementation."
}

variable "targetName" {
  type        = string
  description = "Resolver-selected Target name."
}

variable "targetType" {
  type        = string
  description = "Resolver-selected Target type."
}

output "resource_name" {
  description = "Logical resource name."
  value       = var.resourceName
}
`;

const takosumiContainerServiceMainTf = hcl`variable "serviceName" {
  type        = string
  description = "Logical container service name."
}

variable "implementation" {
  type        = string
  description = "Resolver-selected implementation."
}

variable "targetName" {
  type        = string
  description = "Resolver-selected Target name."
}

variable "targetType" {
  type        = string
  description = "Resolver-selected Target type."
}

variable "image" {
  type        = string
  description = "OCI image reference."
}

variable "ports" {
  type        = list(number)
  description = "Container ports."
  default     = []
}

variable "publicHttp" {
  type        = bool
  description = "Whether this service asks for public HTTP exposure."
  default     = false
}

variable "environment" {
  type        = map(string)
  description = "Non-secret environment variables."
  default     = {}
}

variable "connections" {
  type = map(object({
    resource    = string
    permissions = list(string)
    projection  = string
  }))
  description = "Non-secret Resource Shape connection metadata. The selected adapter owns concrete grant/projection materialization."
  default     = {}
}

output "service_name" {
  description = "Logical container service name."
  value       = var.serviceName
}

output "url" {
  description = "Public URL if projected by the selected adapter."
  value       = ""
}

output "connections" {
  description = "Declared non-secret Resource Shape connection metadata."
  value       = var.connections
}
`;

export const firstPartyModuleFilesByTemplateId: Readonly<
  Record<string, FirstPartyModuleFiles>
> = Object.freeze({
  core: [{ path: "main.tf", text: coreMainTf }],
  "cloudflare-hello-worker": [
    { path: "main.tf", text: cloudflareHelloWorkerMainTf },
  ],
  "cloudflare-worker-service": [
    { path: "main.tf", text: cloudflareWorkerServiceMainTf },
  ],
  "cloudflare-static-site": [
    { path: "main.tf", text: cloudflareStaticSiteMainTf },
  ],
  "cloudflare-r2-bucket": [{ path: "main.tf", text: cloudflareR2BucketMainTf }],
  "cloudflare-kv-store": [{ path: "main.tf", text: cloudflareKVStoreMainTf }],
  "cloudflare-queue": [{ path: "main.tf", text: cloudflareQueueMainTf }],
  "cloudflare-sql-database": [
    { path: "main.tf", text: cloudflareSQLDatabaseMainTf },
  ],
  "takosumi-service-shape": [
    { path: "main.tf", text: takosumiServiceShapeMainTf },
  ],
  "takosumi-container-service": [
    { path: "main.tf", text: takosumiContainerServiceMainTf },
  ],
});
