# Takosumi, BYOC, and external managed Hosts

Takosumi OSS is the control plane for customer BYOC (bring your own cloud).
The Workspace/customer owns the vendor account and credentials. Takosumi Cloud
is a retired historical identity; `app.takosumi.com` availability, pricing, SLA,
and support pages are not current authority.

| Name | Authority / role |
| --- | --- |
| **Takosumi** | The AGPL-3.0 OSS control plane in this repository. It owns the Git/OpenTofu Stack, Runs, state, Outputs, audit, and credential delivery. |
| **Takosumi Hosted** | A separate hosted product that may own retail, commerce, and client composition. It is not the authority for managed supply or provider execution. |
| **Takoserver** | The external Takoform Host for optional managed supply. It owns managed-service Offerings, capacity, provider installation/credentials, backend, execution, WfP namespace/dispatcher, and native identity. |
| **Takosumi Cloud** | A retired historical identity. It is not current authority for availability, pricing, SLA, support, or managed supply. |

## What Takosumi OSS provides

The supported OSS user path is one Stack flow that runs a Git-hosted OpenTofu or
Terraform module. It provides:

- plan, review, apply, state, Outputs, and audit for Git modules;
- Workspace / Project / Capsule / Run lifecycle;
- ProviderConnection, CredentialRecipe, ProviderBinding, and a run-scoped runner; and
- the dashboard, API, CLI, OIDC discovery, and Interface / InterfaceBinding.

Takosumi has no Takosumi-specific `.tf` syntax and ships no first-party provider.
Cloudflare, AWS, Kubernetes, and Takoform are ordinary OpenTofu providers. Takosumi
does not mirror provider-side objects into a second Resource ledger or create a
second lifecycle for them.

## Customer BYOC execution path

In the ordinary BYOC path, the Workspace/customer owns the vendor account,
credential, and resulting resource. Takosumi only mediates the following path:

```text
ProviderConnection
  → CredentialRecipe
  → ProviderBinding
  → run-scoped runner materialization
  → standard OpenTofu provider
  → customer-owned resource
```

Credential values are materialized only inside the runner while the Run is active;
they do not enter Takosumi Outputs, state, logs, or audit. The module and the
customer/operator choose the provider, account, region, backend, and capacity.
Takosumi does not create, own, or infer a vendor account.

## Optional managed supply: the Takoserver Takoform Host

When a module selects the Takoform provider and the customer chooses managed
supply, Takoform remains an ordinary provider. Takosumi may register a
Host-scoped credential for an external Takoserver Takoform Host as an ordinary
ProviderConnection and pass it to the Run through a ProviderBinding.

Takosumi never receives or selects Takoserver's parent provider credential,
provider installation, backend, capacity, Workers for Platforms (WfP) namespace,
dispatcher, or native identity. Takoserver owns those authorities and the
managed-service Offering. Takosumi handles only the Host endpoint and Run result
at the ordinary provider/Interface boundary.

## Retired Resource / Form surfaces

Resource Shape, Form Registry, FormActivation, TargetPool, SpacePolicy, Resolver,
Adapter, and the old `/v1/resources` lifecycle are not supported authoring. Any
remaining routes, schemas, stores, or migrations are compatibility and
migration/delete custody for existing data. New integrations use a Git module and
an ordinary provider; these names are not Takosumi Core authoring authority.

The Generic Offering API/route/store is also not a supported Takosumi Core
authority. Existing endpoints are a legacy/operator-only implementation
conformance gap, unsupported for new integrations, and a removal-target migration
surface. Managed Offerings belong to Takoserver.

## Operator and hosted products

An operator who runs Takosumi chooses the database, runner, backups, provider
connections, support, SLA, and usage treatment. If Takosumi Hosted provides
retail, commerce, or client composition, it does not absorb Takoserver's managed
supply authority or the customer's BYOC credential ownership.

Until Takosumi Hosted publishes current retail documentation, do not infer
availability, pricing, SLA, or support from this OSS repository or the old
`app.takosumi.com` Cloud pages.

## Related

- [How Takosumi works](./index.md)
- [Credentials](./credentials.md)
- [Resource migration internals](./resources.md)
- [API](../reference/api.md)
