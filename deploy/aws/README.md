# Takosumi AWS OpenTofu Profile Runbook

AWS support is an OpenTofu provider profile, not a separate Takosumi runtime
layer. The default profile is `aws-default`.

## Profile

| Field | Value |
| --- | --- |
| Provider | `registry.opentofu.org/hashicorp/aws` |
| Credential ref | `secret://takosumi/aws-default` |
| Runner substrate | `cloudflare-containers` by default |
| State ref | `state://takosumi/aws-default` |
| Lock ref | `lock://takosumi/aws-default` |

The profile allows the AWS provider and records AWS control-plane egress through
exact hosts such as `sts.amazonaws.com`, `iam.amazonaws.com`, and
`route53.amazonaws.com`, plus suffix patterns such as `*.amazonaws.com`.

## Operator Duties

- Resolve `secret://takosumi/aws-default` inside the runner only.
- Prefer short-lived credentials from STS / OIDC federation over long-lived IAM
  access keys.
- Store OpenTofu state and locks in the operator-managed backend referenced by
  the RunnerProfile.
- Do not expose AWS credentials through dashboard JSON, DeploymentOutput,
  diagnostics, audit payloads, or tenant Workers.
- Clone the RunnerProfile when a workload needs a narrower provider allowlist,
  region list, network policy, role ARN, or state backend.

## Live Evidence Required

Before marking AWS ready for an operator, capture non-production evidence for:

1. `tofu init`, `tofu plan`, `tofu apply`, `tofu output -json`, and destroy.
2. state backend ref and lock evidence recorded on ApplyRun.
3. sensitive output omitted from DeploymentOutput.
4. runner diagnostics and failure audit messages redacted.
5. AWS credential material unavailable from tenant runtime surfaces.

This directory intentionally does not ship an AWS production reference
distribution. Running Takosumi itself on ECS / Fargate / EKS / EC2 remains an
operator-owned deployment choice.
