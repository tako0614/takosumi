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

resource "takosumi_container_service" "agent" {
  name        = "agent"
  image       = "ghcr.io/example/agent:1.0.0"
  ports       = [8080]
  public_http = true

  environment = {
    NODE_ENV = "production"
  }
}

output "container_selected_implementation" {
  value = takosumi_container_service.agent.selected_implementation
}

output "container_outputs" {
  value = takosumi_container_service.agent.outputs
}
