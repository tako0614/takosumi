# Service Form Host and Offering Separation (superseded)

> Historical decision record. It is retained for migration provenance only;
> [Core Spec](./core-spec.md) and [Architecture](./architecture.md) are the
> current authorities. The current Takosumi product is the customer BYOC
> control plane with no Generic Offering authority.

## Current-contract summary

The supported Takosumi path is a plain Git/OpenTofu/Terraform Stack. A
Workspace/customer owns the vendor account and credential, and the explicit
provider path is `ProviderConnection` → `CredentialRecipe` → `ProviderBinding`
→ run-scoped materialization. RunAuthority and Executor remain separate, and a
Runner receives one immutable envelope and returns a terminal result or typed
indeterminate outcome.

Takoform remains the portable Form/provider authority. An external Takoserver
Host owns any managed Offering, Form/Resource and Deployment lifecycle,
provider installation/backend, capacity/placement, provider receipt, Workers
for Platforms namespace/dispatcher, native identity, and
commercial/support authority. Takosumi Hosted may compose optional retail,
commerce, or client presentation but does not own managed supply. Takosumi
Cloud is a retired historical identity.

## Historical decision

The old proposal combined a Takosumi OSS Form Host, Resource Shape lifecycle,
Form Registry/FormActivation, TargetPool, SpacePolicy, and generic offerings.
That proposal is no longer the supported OSS product boundary. The current
implementation may still compose parts of those routes and stores; this is a
conformance gap and deletion/migration custody, not a supported exception.

The historical split was:

| Responsibility | Current owner |
| --- | --- |
| Git/OpenTofu control plane, Runs, state, Outputs, audit, provider connections, credential recipes, provider bindings, Interfaces, and InterfaceBindings | Takosumi OSS |
| Portable Form schemas, packages, provider releases, and conformance | Takoform |
| Managed Form/resource lifecycle, Offering, target/capacity/backend/provider management, native identity, receipts, commercial terms, billing, SLA, and support | Takoserver Host |
| Optional retail/commerce/client composition | Takosumi Hosted |

Resource/Form/Offering rows and old route names remain only as migration
custody. They do not make OSS a Form Host, Offering authority, or Resource
authoring authority. Takosumi may carry a Host-scoped credential for an
ordinary Takoform provider call, but never receives a Takoserver parent
provider credential or selects its backend/capacity.

## Migration reference

Use the bounded legacy drain in [Core Spec](./core-spec.md#legacy-resourceform-drain)
for exact read/observe/delete work. Before deleting routes, stores, or schema,
snapshot retained rows, complete an isolated backup/restore drill, prove
inventory-zero and consumer-zero, and remove bootstrap/Worker composition in
the safe order in [Architecture](./architecture.md). A passing compatibility
test or retained route does not revive the old Form Host, FormActivation,
TargetPool, SpacePolicy, Resource, or Generic Offering model.
