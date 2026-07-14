terraform {
  required_version = ">= 1.6.0"
}

variable "name" {
  type        = string
  description = "Human-readable Capsule name."
  default     = "takosumi-keyless-capsule"
}

variable "base_url" {
  type        = string
  description = "Example URL output for ledger/output projection smoke tests."
  default     = "https://keyless.fixture.takosumi.test"
}

output "example_label" {
  description = "An ordinary string output projected by the example smoke configuration."
  value       = var.name
}

output "example_endpoint" {
  description = "An ordinary URL output projected by the example smoke configuration."
  value       = var.base_url
}
