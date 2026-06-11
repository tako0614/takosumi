terraform {
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
