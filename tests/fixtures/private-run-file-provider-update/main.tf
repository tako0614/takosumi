# Synthetic Provider5 normal-update fixture. Not deployment configuration.
terraform {
  required_version = "= 1.12.3"
  required_providers {
    takoform = {
      source  = "registry.terraform.io/tako0614/takoform"
      version = "= 5.0.0"
    }
  }
}

variable "fixture_host_endpoint" { type = string }
variable "fixture_host_api_root" { type = string }
variable "fixture_intent_slot" { type = string }
variable "fixture_store_id" { type = string }

provider "takoform" {
  alias             = "main"
  endpoint          = var.fixture_host_endpoint
  host_api_root     = var.fixture_host_api_root
  store_id          = var.fixture_store_id
  space             = "prod"
  intent_store_slot = var.fixture_intent_slot
}

resource "takoform_module_worker" "app" {
  provider = takoform.main
  name     = "app"
}

resource "takoform_at_least_once_queue" "events" {
  provider = takoform.main
  name     = "events"
  spec = {
    message_retention_seconds = 61
  }
}

output "worker_name" {
  value = takoform_module_worker.app.name
}
