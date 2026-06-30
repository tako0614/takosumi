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

resource "takosumi_kv_store" "cache" {
  name        = "cache"
  consistency = "eventual"
}

output "kv_selected_implementation" {
  value = takosumi_kv_store.cache.selected_implementation
}

output "kv_outputs" {
  value = takosumi_kv_store.cache.outputs
}
