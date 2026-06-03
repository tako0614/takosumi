# Takosumi Conventions

Takosumi v1 is OpenTofu-native. A repository is installed as a plain OpenTofu
module using generic repository metadata; it does not carry a Takosumi-specific
metadata file, component graph, provider selector, or repository metadata field.

## Public Words

- `RunnerProfile`: operator-owned OpenTofu execution policy, credential
  reference boundary, state backend, and runner substrate.
- `PlanRun`: persisted `tofu plan` review record.
- `ApplyRun`: persisted `tofu apply` or destroy execution record.
- `Installation`: Space-scoped installed OpenTofu module.
- `Deployment`: one successful apply result with source identity, runner
  profile, plan digest, provider lock digest, outputs, and status.
- `DeploymentOutput`: non-secret output value, redacted metadata, or secret
  reference extracted from `tofu output -json`.

Use `type` only for JSON Schema, JSON-LD `@type`, or TypeScript names. Do not
add a new Takosumi public selector DSL.

## Operator Runner Boundary

Operator distributions own RunnerProfile policy, provider credentials,
OpenTofu state, runtime attachment, approval, and account-facing policy. A
distribution may populate policy from OpenTofu modules, static config, cloud
APIs, dashboard input, or private ops inventory. Takosumi records policy
decisions, run evidence, Deployment, and DeploymentOutput; it does not own
provider state or credential values.

Backend adapters and runner implementations live in the operator distribution.
Those exports are distribution-local API, not Takosumi source authoring
vocabulary.

## Source And Build

Build recipes stay outside Takosumi. CI or an operator build service calls the
Deploy Control API to create a PlanRun from a Git/local module source, module
path, variables, and RunnerProfile. Apply should pass `expected.planDigest`,
`expected.providerLockDigest`, and source identity guards to prevent drift
between review and execution.
