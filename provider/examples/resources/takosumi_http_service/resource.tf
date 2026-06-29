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

resource "takosumi_http_service" "api" {
  name              = "api"
  runtime_interface = "web_fetch"
  artifact_path     = "/work/dist/worker.js"
  public_http       = true
}

output "api_selected_implementation" {
  value = takosumi_http_service.api.selected_implementation
}

output "api_outputs" {
  value = takosumi_http_service.api.outputs
}
