terraform {
  required_providers {
    takosumi = {
      source = "takosjp/takosumi"
    }
  }
}

# takosumi_interface is the in-run author path: during the Capsule's own
# Takosumi Run the runner injects TAKOSUMI_ENDPOINT, TAKOSUMI_TOKEN (a
# Capsule-scoped run token), TAKOSUMI_WORKSPACE_ID, and TAKOSUMI_CAPSULE_ID,
# so the provider block needs no static configuration.
provider "takosumi" {}

# Declare this module's own MCP server Interface. The endpoint input reads
# this Capsule's ordinary OpenTofu output "mcp_url" (capsule_id defaults to
# the ambient Capsule). Consumer authorization stays service-side through
# InterfaceBinding; this resource never grants access.
resource "takosumi_interface" "mcp" {
  name    = "primary-mcp"
  type    = "mcp.server"
  version = "2025-11-25"

  document_json = jsonencode({
    transport = "streamable-http"
    display = {
      title = "Example MCP server"
    }
  })

  inputs = {
    endpoint = {
      source      = "capsule_output"
      output_name = "mcp_url"
    }
  }

  visibility         = "workspace"
  resource_uri_input = "endpoint"
}

data "takosumi_interface" "mcp" {
  id = takosumi_interface.mcp.id
}

output "mcp_interface_phase" {
  value = data.takosumi_interface.mcp.phase
}
