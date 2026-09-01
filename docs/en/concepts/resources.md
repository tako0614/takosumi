# Resource migration internals

> This page is not a supported product guide. Takosumi OSS currently exposes
> one Git-based OpenTofu/Terraform Stack flow. Resource Shape, Form Host,
> TargetPool, SpacePolicy, and `/v1/resources` are retained temporarily as
> migration internals for old persistence and API/schema compatibility.

## Current authority

Takoform is an ordinary OpenTofu provider installed from
`registry.terraform.io/tako0614/takoform`. Form definitions, packages, provider
releases, conformance, and any Host that stores and realizes Forms are owned by
Takoform or an external project/operator. The external **Takoserver Takoform
Host** is the managed-supply example. Takosumi OSS does not automatically provide
a Form Host or expose TargetPool and SpacePolicy as a user authoring surface.

In the ordinary BYOC path, the Workspace/customer owns the vendor account,
credential, and resulting resource. Execution is
`ProviderConnection → CredentialRecipe → ProviderBinding → run-scoped runner
materialization → standard OpenTofu provider → customer-owned resource`; provider
objects are not copied into a second Takosumi Resource ledger. A Host-scoped
credential for Takoserver is still an ordinary ProviderConnection, but Takosumi
never receives or selects Takoserver's parent provider credential, provider
installation, backend, capacity, WfP namespace/dispatcher/native identity, or
managed Offering.

Normal users configure the providers required by a Git module and its
`ProviderConnection` / `ProviderBinding`, review a plan, and apply a Run.
Deployments describe connection methods with `Interface` and grant use through
`InterfaceBinding`.

## How retained pieces are treated

Existing Resource rows, state, events, schemas, and migrations are not deleted
automatically. They remain only as far as needed for reads and safe
migration/delete custody. The following old API/CLI documents are internal
material for investigating wire and stored data, not contracts for starting new
user-facing authoring:

- the old `/v1/resources` Deploy / Resource lifecycle endpoints
- the `takosumi resources ...` CLI
- Form Registry / FormActivation / Form Host discovery
- the old TargetPool / SpacePolicy / Resolver / Adapter administration

The Generic Offering API/route/store is not a supported Takosumi Core authority.
Existing endpoints are a legacy/operator-only implementation conformance gap,
unsupported for new integrations, and a removal-target migration surface.
Managed Offerings belong to Takoserver.

For legacy data migration or recovery, an operator must use the current
migration runbook and inspect the target endpoint implementation. The OSS
dashboard does not show Resource inventory, editors, detail routes, or links.

## Related current model

- [Overview](./index.md)
- [Interfaces](./interfaces.md)
- [Run model](./run-model.md)
- [Product boundaries](./boundaries.md)
