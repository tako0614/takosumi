# Takosumi

Takosumi is an open-source OpenTofu/Terraform control plane. It runs existing
providers and modules as-is, with ProviderConnections, credential/env injection,
state, secrets, outputs, run history, and audit.

The canonical product direction is [Takosumi Final Plan](../final-plan.md).

## Definition

```text
Takosumi OSS:
  Run existing Terraform/OpenTofu providers as-is.

Takosumi Cloud:
  closed official hosted Takosumi for Operators
  + Cloud-only compatibility gateways
  + Cloud-only managed resources.
```

The most important boundary:

```text
OSS runs existing providers.
Only Cloud has compatibility gateways and managed resources.
```

## Product Shape

| Product | License / operation | Role |
| --- | --- | --- |
| Takosumi Core | OSS | Shared OpenTofu/Terraform execution, ProviderConnection, CredentialRecipe, state, secret, run, audit, output foundation |
| Takosumi | OSS self-host | Personal / small-team self-host product |
| Takosumi for Operators | OSS self-host | Operator edition for organizations and vendors |
| Takosumi Cloud | Closed official hosting | Official hosted Operators + Cloud-only compat / managed resources |

## What OSS Does

```text
clone Git repos
run OpenTofu/Terraform
install existing providers
inject provider credentials from ProviderConnections
store state
store run history
store encrypted secrets
store outputs
handle plan/apply/destroy through UI/API/CLI
```

The core value is:

```text
Same manifest, different connection.
```

## What OSS Does Not Do

```text
Cloudflare compatibility API
AWS/GCP compatibility API
S3 gateway
managed edge
managed container
managed storage
official billing/quota/usage
official cloud backend
```

Start with the [Quickstart](./getting-started/quickstart.md).
