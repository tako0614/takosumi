terraform {
  required_version = ">= 1.5"
}

variable "git_http_url" {
  description = "Git Smart HTTP service endpoint injected by the source.git.smart_http grant."
  type        = string
  default     = ""
}

variable "git_access_token" {
  description = "Scoped read token injected only into the runner sandbox."
  type        = string
  default     = ""
  sensitive   = true
}

variable "git_repo_prefix" {
  description = "Repository prefix assigned to this consumer Capsule."
  type        = string
  default     = ""
}

variable "expected_readme" {
  description = "Exact README content expected from the seeded smoke repository."
  type        = string
  default     = "takosumi staging takos-git clone e2e"
}

resource "terraform_data" "clone" {
  triggers_replace = [
    var.git_http_url,
    var.git_repo_prefix,
    var.expected_readme,
  ]

  provisioner "local-exec" {
    command = <<-EOT
      set -eu
      test -n "$GIT_HTTP_URL"
      test -n "$GIT_ACCESS_TOKEN"
      test -n "$GIT_REPO_PREFIX"
      workdir="$(mktemp -d)"
      trap 'rm -rf "$workdir"' EXIT
      clone_url="$${GIT_HTTP_URL%/}/$${GIT_REPO_PREFIX}/e2e.git"
      authenticated_url="$(printf '%s' "$clone_url" | sed "s#^https://#https://x:$${GIT_ACCESS_TOKEN}@#")"
      GIT_TERMINAL_PROMPT=0 git -c protocol.version=1 clone -q "$authenticated_url" "$workdir/repo"
      test "$(tr -d '\r\n' < "$workdir/repo/README.md")" = "$EXPECTED_README"
    EOT

    environment = {
      GIT_HTTP_URL     = var.git_http_url
      GIT_ACCESS_TOKEN = var.git_access_token
      GIT_REPO_PREFIX  = var.git_repo_prefix
      EXPECTED_README  = var.expected_readme
    }
  }
}

output "app_deployment" {
  value = {
    name    = "git-service-consumer-smoke"
    version = "1.0.0"

    compute = {
      smoke = {
        kind = "job"
        consume = [
          {
            publication = "source.git.smart_http"
            request = {
              scopes = ["read"]
            }
            inject = {
              env = {
                url    = "GIT_HTTP_URL"
                token  = "GIT_ACCESS_TOKEN"
                prefix = "GIT_REPO_PREFIX"
              }
            }
          },
        ]
      }
    }
  }
}

output "clone_verified" {
  description = "True only after the runner completed the real git clone provisioner."
  value       = terraform_data.clone.id != ""
}
