terraform {
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
  description = "Path to the bundled Worker module JS produced by the build phase (copied to /work/artifact by the runner)."
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

# cloudflare_workers_script (provider v5): module-syntax upload. `content` carries
# the bundled JS verbatim; `main_module` names the uploaded module that exports
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
