# @takosjp/takosumi

Umbrella package for the Takosumi contract, installer, kernel, CLI, and runtime-agent.

Core exports:

- `@takosjp/takosumi/contract`
- `@takosjp/takosumi/installer`
- `@takosjp/takosumi/kernel`
- `@takosjp/takosumi/runtime-agent`
- `@takosjp/takosumi/cli`
- `@takosjp/takosumi/server`

Takosumi v1 is manifestless. Core public concepts are Source, Installation, Deployment, and PlatformService.

This package does not replace Terraform/OpenTofu and does not own provider credentials. Operator distributions provide
PlatformService inventory and choose runtime-agent connectors or backend adapters.
