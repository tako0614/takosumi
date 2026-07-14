terraform {
  required_version = ">= 1.6.0"
}

variable "name" {
  type        = string
  description = "Human-readable Capsule name."
  default     = "plain-opentofu-capsule"
}

variable "base_url" {
  type        = string
  description = "Ordinary example URL output."
  default     = "https://capsule.fixture.takosumi.test"
}

output "example_label" {
  description = "An ordinary string output selected explicitly by a smoke configuration."
  value       = var.name
}

output "example_endpoint" {
  description = "An ordinary URL output selected explicitly by a smoke configuration."
  value       = var.base_url
}
