terraform {
  required_version = ">= 1.8.0"

  required_providers {
    takosumi = {
      source = "takosjp/takosumi"
    }
  }
}

provider "takosumi" {}

variable "takosumi_origin" {
  description = "Bare HTTPS origin of the Takosumi platform worker that enabled the operator-control MCP adapter."
  type        = string

  validation {
    condition     = can(regex("^https://[^/?#]+/?$", trimspace(var.takosumi_origin)))
    error_message = "takosumi_origin must be a bare HTTPS origin without a path, query, or fragment."
  }
}

variable "declare_interface_resource" {
  description = "Declare the ordinary mcp.server Interface from takosumi_interface instead of relying on blueprint materialization."
  type        = bool
  default     = false
}

locals {
  endpoint = "${trimsuffix(trimspace(var.takosumi_origin), "/")}/mcp/operator-control/v1"
}

# Optional module-author declaration. The service-side InstallConfig blueprint
# uses the same name/spec. When this resource exists, exclusive
# materializedFrom=capsule_resource ownership wins and the blueprint contributes
# only its installer-owned InterfaceBinding proposal.
resource "takosumi_interface" "operator_control" {
  count = var.declare_interface_resource ? 1 : 0

  name    = "takosumi.operator-control"
  type    = "mcp.server"
  version = "2025-11-25"

  document_json = jsonencode({
    transport = "streamable-http"
    display = {
      title = "Takosumi Operator Control"
    }
  })

  inputs = {
    endpoint = {
      source      = "capsule_output"
      output_name = "endpoint"
    }
  }

  visibility         = "workspace"
  resource_uri_input = "endpoint"
}

output "endpoint" {
  description = "Credential-free exact resource URI published as an ordinary Capsule Output."
  value       = local.endpoint
}
