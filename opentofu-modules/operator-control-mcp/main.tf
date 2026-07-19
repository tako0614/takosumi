terraform {
  required_version = ">= 1.8.0"
}

variable "takosumi_origin" {
  description = "Bare HTTPS origin of the Takosumi platform worker that enabled the operator-control MCP adapter."
  type        = string

  validation {
    condition     = can(regex("^https://[^/?#]+/?$", trimspace(var.takosumi_origin)))
    error_message = "takosumi_origin must be a bare HTTPS origin without a path, query, or fragment."
  }
}

locals {
  endpoint = "${trimsuffix(trimspace(var.takosumi_origin), "/")}/mcp/operator-control/v1"
}

output "endpoint" {
  description = "Credential-free exact resource URI published as an ordinary Capsule Output."
  value       = local.endpoint
}
