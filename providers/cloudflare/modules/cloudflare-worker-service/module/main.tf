terraform {
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

variable "compatibilityFlags" {
  type        = list(string)
  description = "Workers runtime compatibility flags."
  default     = []
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

# cloudflare_workers_script (provider v5): module-syntax upload. `content` carries
# the bundled JS verbatim; `main_module` names the uploaded module that exports
# the fetch handler. Provider credentials are minted by Takosumi at dispatch via
# CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID; no inline secrets here.
resource "cloudflare_workers_script" "this" {
  account_id          = var.accountId
  script_name         = var.appName
  content             = local.artifact_content
  main_module         = "index.js"
  compatibility_date  = var.compatibilityDate
  compatibility_flags = var.compatibilityFlags

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
