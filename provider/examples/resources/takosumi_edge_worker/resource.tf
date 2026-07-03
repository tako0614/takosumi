terraform {
  required_providers {
    takosumi = {
      source = "takosjp/takosumi"
    }
  }
}

provider "takosumi" {
  endpoint = "https://takosumi.example.com"
  space    = "prod"
}

resource "takosumi_edge_worker" "api" {
  name               = "api"
  artifact_url       = "https://example.com/releases/api-worker.js"
  artifact_sha256    = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
  compatibility_date = "2026-06-29"
  profiles           = ["workers_bindings"]
}

output "api_selected_implementation" {
  value = takosumi_edge_worker.api.selected_implementation
}

output "api_outputs" {
  value = takosumi_edge_worker.api.outputs
}
