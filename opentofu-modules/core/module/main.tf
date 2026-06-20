# core (first-party base-installation module)
#
# The base Installation under a Space (spec §5/§10). For MVP this is a pure
# value-plumbing module: it derives generic service origins from a single
# `base_domain` input and exposes them as outputs. It declares NO
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
  public_origin = "https://${local.base_domain}"
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
  value       = "${local.public_origin}/auth"
}

output "service_registry_url" {
  description = "Well-known service registry URL advertised by this installation."
  value       = "${local.public_origin}/.well-known/takosumi-services.json"
}
