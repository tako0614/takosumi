# Takosumi Kubernetes OpenTofu Profile Runbook

Kubernetes support is an OpenTofu provider profile, not a separate Takosumi
runtime layer. The default profile is `kubernetes-default`.

## Profile

| Field | Value |
| --- | --- |
| Providers | `registry.opentofu.org/hashicorp/kubernetes`, `registry.opentofu.org/hashicorp/helm` |
| Credential ref | `secret://takosumi/kubernetes-default` |
| Runner substrate | `cloudflare-containers` by default |
| State ref | `state://takosumi/kubernetes-default` |
| Lock ref | `lock://takosumi/kubernetes-default` |

The profile uses `networkPolicy.mode: "operator-managed"` because Kubernetes
API hosts are cluster-specific. The default records
`kubernetes.default.svc`, `*.svc`, and `*.cluster.local` as the in-cluster
shape, but each operator must narrow this for their cluster.

## Operator Duties

- Resolve `secret://takosumi/kubernetes-default` inside the runner only.
- Use a namespace-scoped service account where possible.
- Keep kubeconfig / bearer token / client certificate material out of dashboard
  JSON, DeploymentOutput, diagnostics, audit payloads, and tenant Workers.
- Store OpenTofu state and locks in the operator-managed backend referenced by
  the RunnerProfile.
- Clone the RunnerProfile for each cluster or trust boundary.

## Live Evidence Required

Before marking Kubernetes ready for an operator, capture non-production evidence
for:

1. `tofu init`, `tofu plan`, `tofu apply`, `tofu output -json`, and destroy.
2. successful Kubernetes provider authentication against the intended cluster.
3. Helm provider evidence if Helm is enabled.
4. state backend ref and lock evidence recorded on ApplyRun.
5. sensitive output omitted from DeploymentOutput.
6. credential material unavailable from tenant runtime surfaces.

This directory intentionally does not ship a production Helm chart. Running
Takosumi itself on Kubernetes remains an operator-owned deployment choice.
