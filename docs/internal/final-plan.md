# Takosumi Final Plan (superseded)

> This is a historical planning record. It is retained so migration and
> release evidence can link to the decisions that preceded the current model.
> It is not the current product direction and must not be used as a source of
> supported routes, ownership, or release requirements. The present contract
> is [Core Spec](./core-spec.md), and its target decomposition is
> [Architecture](./architecture.md).

## Current-contract summary

The current Takosumi OSS contract is a customer BYOC control plane:

- the supported user path is one plain Git/OpenTofu/Terraform Stack flow;
- the Workspace/customer owns the vendor account and credential;
- the complete provider path is `ProviderConnection` → `CredentialRecipe` →
  `ProviderBinding` → run-scoped materialization;
- Core converges on StackCatalog, RunAuthority, CredentialBroker,
  ArtifactLedger, and a narrow Executor;
- RunOwner/RunAuthority and RunnerObject/Executor remain separate, with an
  at-most-once mutation fence and typed indeterminate reconciliation;
- Takosumi ships no first-party Terraform/OpenTofu provider and has no Generic
  Offering authority;
- Takoform remains the portable Form/provider authority, while an external
  Takoserver Host owns managed Offerings, capacity, provider/backend lifecycle,
  and support/commercial authority; and
- Takosumi Hosted is optional retail/commerce/client composition only. Takosumi
  Cloud is a retired historical identity.

Takoserver is not in the customer BYOC path. A Takoform provider may call the
Takoserver Host with a Host-scoped credential, but Takosumi never receives the
Host's parent provider credential, installation, backend, capacity, Workers
for Platforms namespace/dispatcher, or native identity.

## Retained migration note

Old Resource/Form wire, state, audit, and Offering rows may remain readable
while an operator migrates them. The legacy edge is normally absent (`404`). An
operator may set `TAKOSUMI_LEGACY_RESOURCE_DRAIN_ENABLED=1` together with the
authenticated control-plane configuration to expose only the bounded drain:
authenticated Resource list/read/events/observe/delete and TargetPool or
SpacePolicy `GET`/`HEAD`/`DELETE`. Discovery, FormActivation, writes, preview,
import, refresh, Offering selection, and all other legacy operations remain
unavailable (`404` or `410`); enabling the drain never creates a supported
authoring flow.

Resource Shape, Form Registry, FormActivation, TargetPool, SpacePolicy, and
Generic Offering are migration-only/delete custody. Existing bootstrap/Worker
composition is a conformance gap to remove only after exact inventory,
backup/restore evidence, and consumer-zero proof. Managed-service Offering
facts move to Takoserver; optional retail/client presentation moves to
Takosumi Hosted.

For current contracts, use Core Spec and the product reference docs. For
historical package or exact-FormRef evidence, use the explicitly superseded
runbooks under [`docs/operations/`](../operations/README.md).
