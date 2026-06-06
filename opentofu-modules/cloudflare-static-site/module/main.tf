terraform {
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
  value       = "https://${cloudflare_pages_project.this.name}.pages.dev"
}
