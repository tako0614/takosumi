# Takosumi Azure OpenTofu Profile Runbook

Azure support is an OpenTofu provider profile, not a separate Takosumi runtime
layer. The default profile is `azure-default`.

## Profile

| Field | Value |
| --- | --- |
| Provider | `registry.opentofu.org/hashicorp/azurerm` |
| Credential ref | `secret://takosumi/azure-default` |
| Runner substrate | `cloudflare-containers` by default |
| State ref | `state://takosumi/azure-default` |
| Lock ref | `lock://takosumi/azure-default` |

The profile allows Azure Resource Manager and records Azure control-plane egress
through exact hosts such as `login.microsoftonline.com`,
`management.azure.com`, and `graph.microsoft.com`, plus suffix patterns such as
`*.azure.com`, `*.windows.net`, and `*.microsoftonline.com`.

## Operator Duties

- Resolve `secret://takosumi/azure-default` inside the runner only.
- Prefer workload identity federation or short-lived service principal tokens
  over long-lived client secrets.
- Store OpenTofu state and locks in the operator-managed backend referenced by
  the RunnerProfile.
- Do not expose Azure credentials through dashboard JSON, DeploymentOutput,
  diagnostics, audit payloads, or tenant Workers.
- Clone the RunnerProfile when a workload needs a narrower subscription,
  tenant, region, API host list, or state backend.

## Live Evidence Required

Before marking Azure ready for an operator, capture non-production evidence for:

1. `tofu init`, `tofu plan`, `tofu apply`, `tofu output -json`, and destroy.
2. state backend ref and lock evidence recorded on ApplyRun.
3. sensitive output omitted from DeploymentOutput.
4. runner diagnostics and failure audit messages redacted.
5. Azure credential material unavailable from tenant runtime surfaces.

This directory intentionally does not ship an Azure production reference
distribution. Running Takosumi itself on Azure Container Apps / AKS / VMs
remains an operator-owned deployment choice.
