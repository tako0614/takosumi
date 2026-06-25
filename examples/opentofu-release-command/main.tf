terraform {
  required_version = ">= 1.6.0"
}

variable "name" {
  type        = string
  description = "Human-readable Capsule name."
  default     = "takosumi-release-command"
}

variable "base_url" {
  type        = string
  description = "Example URL output available to the release command."
  default     = "https://release.fixture.takosumi.test"
}

output "worker_name" {
  description = "Stable string output used by the generic Capsule smoke."
  value       = var.name
}

output "url" {
  description = "Stable URL output used by the generic Capsule smoke."
  value       = var.base_url
}

output "takosumi_release" {
  description = "Opaque post-apply command executed by Takosumi after apply."
  value = {
    post_apply = [
      {
        id                = "activate"
        executor          = "runner"
        command           = ["bun", "-e", "const outputs = JSON.parse(Bun.env.TAKOSUMI_OUTPUTS_JSON || '{}'); const context = JSON.parse(Bun.env.TAKOSUMI_RELEASE_CONTEXT_JSON || '{}'); if (!outputs.url || context.outputs?.url !== outputs.url || context.kind !== 'takosumi.release-context@v1') process.exit(12); console.log('activated ' + context.outputs.url);"]
        working_directory = "."
      },
    ]
  }
}
