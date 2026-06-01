# Takosumi Conventions

Takosumi v1 is manifestless. A source repository is installed through `Source`
input and generic repository metadata; it does not carry a Takosumi-specific
metadata file, component graph, provider selector, or repository metadata
field.

## Public Words

- `Source`: `git`, `prepared`, or `local` source input plus resolved identity.
- `Installation`: Space-scoped installed source record.
- `Deployment`: one apply result with source summary, plan snapshot, binding
  snapshot, outputs, and status.
- `PlatformService`: operator-catalog service capability selected during install
  or deploy.
- `InstallPlan`: dry-run response snapshot only; not a persisted entity.

Use `type` only for JSON Schema, JSON-LD `@type`, or TypeScript names. Do not
add a new public selector DSL under Takosumi core.

## Operator Binding

Operator distributions own PlatformService inventory, provider credentials,
Terraform/OpenTofu state, runtime attachment, and account-facing policy. A
distribution may populate inventory from Terraform output, HCP Stacks publish
output, static config, cloud APIs, or dashboard input. Takosumi core records the
resolved binding snapshot on Deployment; it does not materialize provider
infrastructure.

Backend adapters and runtime-agent connectors live in `takosumi-plugins/` as
optional reference implementation. Operators attach them through
`createPaaSApp({ plugins })` or an equivalent distribution-local binding layer.
Those adapter subpaths are package API, not Takosumi source authoring
vocabulary.

## Source And Build

Build recipes stay outside Takosumi core. CI or an operator build service can
produce a prepared source archive and submit it as `source.kind: "prepared"`.
Git and local source paths are accepted directly by the Installer API.

`planSnapshotDigest` is the reviewed dry-run guard. Apply should pass it through
`expected.planSnapshotDigest` when the caller wants to prevent source or binding
resolution drift between dry-run and apply.
