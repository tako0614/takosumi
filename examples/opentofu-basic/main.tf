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

output "worker_name" {
  description = "Stable string output used by the generic Capsule smoke."
  value       = var.name
}

output "url" {
  description = "Stable URL output used by the generic Capsule smoke."
  value       = var.base_url
}
