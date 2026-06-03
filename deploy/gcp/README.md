# Takosumi GCP OpenTofu Profile Runbook

GCP support is an OpenTofu provider profile, not a separate Takosumi runtime
layer. The default profile is `gcp-default`.

## Profile

| Field | Value |
| --- | --- |
| Provider | `registry.opentofu.org/hashicorp/google` |
| Credential ref | `secret://takosumi/gcp-default` |
| Runner substrate | `cloudflare-containers` by default |
| State ref | `state://takosumi/gcp-default` |
| Lock ref | `lock://takosumi/gcp-default` |

The profile allows the Google provider and records GCP control-plane egress
through exact hosts such as `oauth2.googleapis.com`,
`cloudresourcemanager.googleapis.com`, `serviceusage.googleapis.com`, and
`iam.googleapis.com`, plus the suffix pattern `*.googleapis.com`.

## Operator Duties

- Resolve `secret://takosumi/gcp-default` inside the runner only.
- Prefer workload identity federation or short-lived service account tokens over
  long-lived JSON keys.
- Store OpenTofu state and locks in the operator-managed backend referenced by
  the RunnerProfile.
- Do not expose GCP credentials through dashboard JSON, DeploymentOutput,
  diagnostics, audit payloads, or tenant Workers.
- Clone the RunnerProfile when a workload needs a narrower project, region,
  API host list, or state backend.

## Live Evidence Required

Before marking GCP ready for an operator, capture non-production evidence for:

1. `tofu init`, `tofu plan`, `tofu apply`, `tofu output -json`, and destroy.
2. state backend ref and lock evidence recorded on ApplyRun.
3. sensitive output omitted from DeploymentOutput.
4. runner diagnostics and failure audit messages redacted.
5. GCP credential material unavailable from tenant runtime surfaces.

This directory intentionally does not ship a GCP production reference
distribution. Running Takosumi itself on Cloud Run / GKE / GCE remains an
operator-owned deployment choice.
