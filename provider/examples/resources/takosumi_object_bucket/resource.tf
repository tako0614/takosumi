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

# ObjectBucket is not inferred from plain cloud targets. The operator must
# enable a managed ObjectBucket implementation explicitly; ordinary S3/R2/GCS
# buckets should use existing OpenTofu providers instead.
resource "takosumi_target_pool" "default" {
  name = "default"

  target = [{
    name     = "cloudflare-main"
    type     = "cloudflare"
    ref      = "cf-account-id"
    priority = 80

    implementation = [{
      shape                = "ObjectBucket"
      implementation       = "cloudflare_r2"
      native_resource_type = "cloudflare.r2_bucket"
      interfaces = {
        s3_api        = "native"
        signed_url    = "native"
        object_events = "shim"
      }
    }]
  }]
}

resource "takosumi_object_bucket" "assets" {
  name = "assets"

  interfaces = [
    "s3_api",
    "signed_url",
  ]

  lifecycle_policy = {
    delete = "retain"
  }

  depends_on = [takosumi_target_pool.default]
}

# The backend implementation/target is chosen server-side by the Takosumi
# Resolver; the provider only carries the thin resolution handle.
output "assets_selected_implementation" {
  value = takosumi_object_bucket.assets.selected_implementation
}

output "assets_outputs" {
  value = takosumi_object_bucket.assets.outputs
}
