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

output "worker_name" {
  value = null_resource.marker.triggers.name
}

output "url" {
  value = "https://example.invalid/${null_resource.marker.triggers.name}"
}
