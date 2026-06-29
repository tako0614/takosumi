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
  # token is sensitive; prefer the TAKOSUMI_TOKEN environment variable.
  # token  = var.takosumi_token
}

resource "takosumi_object_store" "assets" {
  name = "assets"

  interfaces = [
    "s3_api",
    "signed_url",
  ]

  lifecycle_policy = {
    delete = "retain"
  }
}

# The backend implementation/target is chosen server-side by the Takosumi
# Resolver; the provider only carries the thin resolution handle.
output "assets_selected_implementation" {
  value = takosumi_object_store.assets.selected_implementation
}

output "assets_outputs" {
  value = takosumi_object_store.assets.outputs
}
