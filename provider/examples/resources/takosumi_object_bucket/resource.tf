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

resource "takosumi_object_bucket" "assets" {
  name          = "assets"
  storage_class = "standard"
  interfaces    = ["s3_api", "signed_url"]
}

output "bucket_selected_implementation" {
  value = takosumi_object_bucket.assets.selected_implementation
}

output "bucket_outputs" {
  value = takosumi_object_bucket.assets.outputs
}
