terraform {
  required_providers {
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }
}

variable "name" {
  type    = string
  default = "takosumi-null-provider"
}

resource "null_resource" "marker" {
  triggers = {
    name = var.name
  }
}

output "example_label" {
  value = null_resource.marker.triggers.name
}

output "example_endpoint" {
  value = "https://example.invalid/${null_resource.marker.triggers.name}"
}
