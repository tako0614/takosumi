terraform {
  required_version = ">= 1.6.0"
}

variable "public_url" {
  description = "Public URL assigned to this providerless Capsule."
  type        = string
  default     = null

  validation {
    condition     = var.public_url == null || can(regex("^https://[^[:space:]]+$", var.public_url))
    error_message = "public_url must be unset or an https URL."
  }
}

variable "takosumi_accounts_issuer_url" {
  description = "Takosumi Accounts issuer supplied by the host."
  type        = string
  default     = ""
}

variable "takosumi_accounts_client_id" {
  description = "Takosumi Accounts OIDC client supplied by the host."
  type        = string
  default     = ""
}

variable "takosumi_accounts_redirect_uri" {
  description = "OIDC redirect URI supplied by the host."
  type        = string
  default     = ""
}

output "public_url" {
  description = "The public URL used by the principal Capsule."
  value       = var.public_url
}
