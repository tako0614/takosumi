terraform {
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
    ? "https://${cloudflare_workers_script.this.script_name}.${var.accountSubdomain}.workers.dev"
    : ""
  )
}
