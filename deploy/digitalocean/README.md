# Takosumi DigitalOcean OpenTofu Profile Runbook

DigitalOcean support is an OpenTofu provider profile. The default profile is
`digitalocean-default`.

## Profile

| Field | Value |
| --- | --- |
| Provider | `registry.opentofu.org/digitalocean/digitalocean` |
| Credential ref | `secret://takosumi/digitalocean-default` |
| Runner substrate | `cloudflare-containers` by default |
| State ref | `state://takosumi/digitalocean-default` |
| Lock ref | `lock://takosumi/digitalocean-default` |

The profile records egress to `api.digitalocean.com` and the OpenTofu provider
registry.

## Operator Duties

- Resolve `secret://takosumi/digitalocean-default` inside the runner only.
- Use a token scoped to the intended non-production project during readiness
  proof.
- Keep token material out of dashboard JSON, DeploymentOutput, diagnostics,
  audit payloads, and tenant Workers.
- Clone the RunnerProfile when a workload needs a narrower project, region, API
  host list, or state backend.

## Live Evidence Required

Before marking DigitalOcean ready for an operator, capture non-production
evidence for `tofu plan/apply/destroy`, state lock recording, sensitive output
blocking, and secret leak checks against diagnostics, audit payloads, and tenant
runtime surfaces.
