# Takosumi GitHub OpenTofu Profile Runbook

GitHub support is an OpenTofu provider profile. The default profile is
`github-default`.

## Profile

| Field | Value |
| --- | --- |
| Provider | `registry.opentofu.org/integrations/github` |
| Credential ref | `secret://takosumi/github-default` |
| Runner substrate | `cloudflare-containers` by default |
| State ref | `state://takosumi/github-default` |
| Lock ref | `lock://takosumi/github-default` |

The profile records egress to `api.github.com`, `uploads.github.com`, and
GitHub content hosts required by provider operations.

## Operator Duties

- Resolve `secret://takosumi/github-default` inside the runner only.
- Prefer GitHub App installation tokens or fine-scoped tokens over broad PATs.
- Keep GitHub token material out of dashboard JSON, DeploymentOutput,
  diagnostics, audit payloads, and tenant Workers.
- Clone the RunnerProfile when a workload needs a narrower organization,
  repository set, or token scope.

## Live Evidence Required

Before marking GitHub ready for an operator, capture non-production evidence for
`tofu plan/apply/destroy`, state lock recording, sensitive output blocking, and
secret leak checks against diagnostics, audit payloads, and tenant runtime
surfaces.
