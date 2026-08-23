# Resource migration internals

> This page is not a supported product guide. Takosumi OSS currently exposes
> one Git-based OpenTofu/Terraform Stack flow. Resource Shape, Form Host,
> TargetPool, and SpacePolicy schemas and retained rows are migration data only;
> their former `/v1` HTTP and CLI surfaces are retired.

## Current authority

Takoform is an ordinary OpenTofu provider installed from
`registry.terraform.io/tako0614/takoform`. Form definitions, packages,
provider releases, conformance, and any Host that stores and realizes Forms are
owned by Takoform or an external project/operator such as the Takosumi hosted service.
Takosumi OSS does not automatically provide a Form Host or expose TargetPool
and SpacePolicy as a user authoring surface.

Normal users configure the providers required by a Git module and its
`ProviderConnection` / `ProviderBinding`, review a plan, and apply a Run.
Deployments describe connection methods with `Interface` and grant use through
`InterfaceBinding`.

## How retained pieces are treated

Existing Resource rows, state, events, schemas, and migrations are not deleted.
They remain only as far as needed for reads and safe migration. The following
old API/CLI documents are internal material for investigating wire and stored
data, not contracts for starting new user-facing authoring:

- the old Deploy / Resource lifecycle HTTP endpoints
- the `takosumi resources ...` CLI
- Form Registry / FormActivation / Form Host discovery
- the old TargetPool / SpacePolicy / Resolver / Adapter administration

For legacy data migration or recovery, an operator must use the current
migration runbook and inspect the target endpoint implementation. The OSS
dashboard does not show Resource inventory, editors, detail routes, or links.

## Related current model

- [Overview](./index.md)
- [Interfaces](./interfaces.md)
- [Run model](./run-model.md)
- [Product boundaries](./boundaries.md)
