terraform {
  required_version = ">= 1.5"
}

variable "git_http_url" {
  description = "Git Smart HTTP endpoint injected from a source.git.smart_http service grant."
  type        = string
  default     = ""
}

variable "git_access_token" {
  description = "Scoped Git service credential injected by Takosumi at plan time."
  type        = string
  default     = ""
  sensitive   = true
}

variable "git_repo_prefix" {
  description = "Repository namespace injected from the selected Git service."
  type        = string
  default     = ""
}

output "app_deployment" {
  description = "Test-only consumer declaration used by hosted service-grant E2E."
  value = {
    name    = "git-service-consumer"
    version = "1.0.0"
    compute = {
      probe = {
        kind = "worker"
        consume = [
          {
            publication = "source.git.smart_http"
            request = {
              scopes = ["repos:write"]
            }
          },
        ]
      }
    }
  }
}

output "grant_probe" {
  description = "True only when URL, scoped credential, and repository prefix were injected."
  value = nonsensitive(
    trimspace(var.git_http_url) != "" &&
    trimspace(var.git_access_token) != "" &&
    trimspace(var.git_repo_prefix) != ""
  )
}
