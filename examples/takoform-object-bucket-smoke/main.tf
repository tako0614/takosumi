terraform {
  required_version = ">= 1.6.0"

  required_providers {
    takoform = {
      source  = "registry.opentofu.org/tako0614/takoform"
      version = "= 1.0.2"
    }
  }
}

variable "bucket_name" {
  description = "Unique portable object-bucket name for this Capsule run."
  type        = string
  default     = "takosumi-object-bucket-smoke"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,62}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be 3-64 lowercase letters, numbers, or hyphens, and start/end with an alphanumeric character."
  }
}

resource "takoform_object_bucket" "smoke" {
  name          = var.bucket_name
  storage_class = "standard"
}

output "object_bucket_id" {
  description = "Canonical Takoform resource id for the object bucket."
  value       = takoform_object_bucket.smoke.id
}
