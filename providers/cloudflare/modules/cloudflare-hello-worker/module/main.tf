terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

# Starter capsule: a runnable Cloudflare Worker with NO build step. Unlike
# cloudflare-worker-service (which uploads a built artifact) this bakes the
# Worker source inline, so `tofu apply` alone produces something you can open —
# the workers.dev URL is an output. Provider credentials are minted by Takosumi
# at dispatch (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID); no inline secrets.

variable "accountId" {
  type        = string
  description = "Cloudflare account id that owns the Worker."
}

variable "appName" {
  type        = string
  description = "Worker script name (also the label in the workers.dev URL)."
  default     = "takosumi-hello"
}

variable "accountSubdomain" {
  type        = string
  description = "The account's workers.dev subdomain (<this>.workers.dev). Used only to render the public url output."
  default     = ""
}

variable "compatibilityDate" {
  type        = string
  description = "Workers runtime compatibility date."
  default     = "2025-01-01"
}

# Inline ES-module Worker — a tiny HTML page so a fresh install has something
# real to open. No build pipeline, no artifact file. The Worker source is a
# heredoc using single-quoted JS strings (HTML attributes use double quotes),
# so the module stays free of backticks and `$${}` interpolation.
locals {
  worker_module = <<-EOT
    export default { async fetch() { return new Response('<!doctype html><meta charset="utf-8"><title>Hello from Takosumi</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:36rem;margin:12vh auto;padding:0 1.5rem;color:#1a1a1a}</style><h1>It works</h1><p>This Worker was provisioned by a Takosumi Installation: reviewed plan, applied, live.</p><p>Edit the capsule and re-deploy to make it yours.</p>', { headers: { 'content-type': 'text/html; charset=utf-8' } }); } };
  EOT
}

resource "cloudflare_workers_script" "this" {
  account_id         = var.accountId
  script_name        = var.appName
  content            = local.worker_module
  main_module        = "index.js"
  compatibility_date = var.compatibilityDate
}

# Expose the Worker on <account>.workers.dev so the install has a reachable URL.
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
  description = "workers.dev URL for the Worker (empty until the account subdomain is known)."
  value = (
    var.accountSubdomain != ""
    ? "https://${cloudflare_workers_script.this.script_name}.${var.accountSubdomain}.workers.dev"
    : ""
  )
}
